//! Controller-side resource transfer shared by SSH and encrypted peer readers.
//! No filesystem or transport fallback is permitted. Cached bytes always need
//! a successful owner-side metadata read before they can be served again.

use super::HtmlPreviewSource;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures::{stream, stream::BoxStream, StreamExt};
use openbitfun_product_domains::html_preview::{
    HtmlPreviewError, HtmlPreviewResource, HtmlPreviewResourceRequest, MAX_PREVIEW_BYTES,
    PREVIEW_CHUNK_BYTES,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

/// Each response can hold at most four completed/in-flight chunks ahead of its
/// consumer. The per-preview limits also cover concurrent browser resource URLs.
const PREFETCH_CHUNKS: usize = 4;
const ACTIVE_RESOURCES: usize = 8;
const ACTIVE_READS: usize = 8;
const CACHE_BYTES: usize = 16 * 1024 * 1024;
const CACHE_RESOURCE_BYTES: u64 = 4 * 1024 * 1024;
const CACHE_ENTRIES: usize = 64;
// SFTP v3 timestamps can have one-second resolution. Never extend this lifetime
// on a metadata hit; explicit browser reloads bypass the cache as well.
const CACHE_LIFETIME: Duration = Duration::from_secs(5);

#[async_trait::async_trait]
pub trait HtmlPreviewReader: Send + Sync {
    fn is_current(&self) -> bool {
        true
    }
    async fn read(
        &self,
        request: &HtmlPreviewResourceRequest,
    ) -> Result<HtmlPreviewResource, HtmlPreviewError>;
}

#[async_trait::async_trait]
impl HtmlPreviewReader for HtmlPreviewSource {
    async fn read(
        &self,
        request: &HtmlPreviewResourceRequest,
    ) -> Result<HtmlPreviewResource, HtmlPreviewError> {
        HtmlPreviewSource::read(self, request).await
    }
}

pub type PreviewBody = BoxStream<'static, Result<Arc<[u8]>, HtmlPreviewError>>;

pub struct PreviewResource {
    /// Metadata only; content is delivered by the bounded body stream.
    pub metadata: HtmlPreviewResource,
    pub body: PreviewBody,
}

struct CachedResource {
    metadata: HtmlPreviewResource,
    chunks: Vec<Arc<[u8]>>,
    created: Instant,
}

#[derive(Default)]
struct ResourceCache {
    entries: HashMap<String, Arc<CachedResource>>,
    bytes: usize,
}

impl ResourceCache {
    fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.bytes -= entry.metadata.size as usize;
        }
    }

    fn get(&mut self, key: &str) -> Option<Arc<CachedResource>> {
        if self.entries.get(key)?.created.elapsed() >= CACHE_LIFETIME {
            self.remove(key);
            return None;
        }
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: String, metadata: HtmlPreviewResource, chunks: Vec<Arc<[u8]>>) {
        self.remove(&key);
        let size = metadata.size as usize;
        while self.bytes + size > CACHE_BYTES || self.entries.len() >= CACHE_ENTRIES {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.created)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.remove(&oldest);
        }
        self.bytes += size;
        self.entries.insert(
            key,
            Arc::new(CachedResource {
                metadata,
                chunks,
                created: Instant::now(),
            }),
        );
    }
}

/// One instance belongs to one preview and immutable reader/account/workspace
/// binding. Closing that preview drops its cache and cancels queued/in-flight IO.
pub struct HtmlPreviewTransfer {
    reader: Arc<dyn HtmlPreviewReader>,
    closed: watch::Receiver<bool>,
    resources: Arc<Semaphore>,
    reads: Arc<Semaphore>,
    cache: Mutex<ResourceCache>,
    loads: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
}

impl HtmlPreviewTransfer {
    pub fn new(reader: Arc<dyn HtmlPreviewReader>, closed: watch::Receiver<bool>) -> Self {
        Self {
            reader,
            closed,
            resources: Arc::new(Semaphore::new(ACTIVE_RESOURCES)),
            reads: Arc::new(Semaphore::new(ACTIVE_READS)),
            cache: Default::default(),
            loads: Default::default(),
        }
    }

    pub fn is_current(&self) -> bool {
        !*self.closed.borrow() && self.reader.is_current()
    }

    async fn while_open<T>(
        &self,
        future: impl std::future::Future<Output = Result<T, HtmlPreviewError>>,
    ) -> Result<T, HtmlPreviewError> {
        if !self.is_current() {
            return Err(closed_error());
        }
        let mut closed = self.closed.clone();
        tokio::select! {
            _ = closed.wait_for(|closed| *closed) => Err(closed_error()),
            result = future => {
                if !self.is_current() { return Err(closed_error()); }
                result
            }
        }
    }

    async fn acquire(
        &self,
        semaphore: &Arc<Semaphore>,
    ) -> Result<OwnedSemaphorePermit, HtmlPreviewError> {
        self.while_open(async {
            semaphore
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| closed_error())
        })
        .await
    }

    async fn read(
        &self,
        request: &HtmlPreviewResourceRequest,
    ) -> Result<(HtmlPreviewResource, Arc<[u8]>), HtmlPreviewError> {
        let _permit = self.acquire(&self.reads).await?;
        let mut resource = self.while_open(self.reader.read(request)).await?;
        let bytes = validate_chunk(&resource, request)?;
        resource.content_base64 = String::new();
        Ok((resource, bytes.into()))
    }

    pub async fn open(
        self: &Arc<Self>,
        mut request: HtmlPreviewResourceRequest,
        bypass_cache: bool,
        // HTTP adapters include the query here, never in the filesystem path.
        cache_key: Option<String>,
    ) -> Result<PreviewResource, HtmlPreviewError> {
        let permit = self.acquire(&self.resources).await?;
        // Preview HTTP responses always start at offset zero; never reinterpret
        // a chunk request as a complete resource response.
        if request.offset != 0 {
            return Err(HtmlPreviewError::unavailable(
                "Invalid preview resource offset",
            ));
        }
        if request.metadata_only {
            let (metadata, _) = self.read(&request).await?;
            return Ok(PreviewResource {
                metadata,
                body: stream::empty().boxed(),
            });
        }
        let key = cache_key.unwrap_or_else(|| request.resource_path.clone().unwrap_or_default());
        let lock = {
            let mut loads = self.loads.lock().unwrap();
            loads.retain(|_, lock| lock.strong_count() > 0);
            let lock = loads.get(&key).and_then(Weak::upgrade).unwrap_or_default();
            loads.insert(key.clone(), Arc::downgrade(&lock));
            lock
        };
        let load_guard = self
            .while_open(async { Ok(lock.lock_owned().await) })
            .await?;
        let cached = {
            let mut cache = self.cache.lock().unwrap();
            if bypass_cache {
                cache.remove(&key);
            }
            cache.get(&key)
        };
        if let Some(cached) = cached {
            let mut probe = request.clone();
            probe.metadata_only = true;
            // A version mismatch is a normal cache miss; offline/forbidden is an
            // error and must never serve stale bytes from the controller cache.
            let current = self.read(&probe).await;
            if let Ok((metadata, _)) = &current {
                if cached.created.elapsed() < CACHE_LIFETIME
                    && same_resource(metadata, &cached.metadata)
                {
                    let transfer = self.clone();
                    let metadata = metadata.clone();
                    let body =
                        stream::try_unfold(
                            (cached, 0, permit, load_guard),
                            move |(cached, index, permit, load_guard)| {
                                let transfer = transfer.clone();
                                async move {
                                    if !transfer.is_current() {
                                        return Err(closed_error());
                                    }
                                    Ok(cached.chunks.get(index).cloned().map(|bytes| {
                                        (bytes, (cached, index + 1, permit, load_guard))
                                    }))
                                }
                            },
                        )
                        .boxed();
                    return Ok(PreviewResource { metadata, body });
                }
            }
            self.cache.lock().unwrap().remove(&key);
            current?;
        }
        let (metadata, first) = self.read(&request).await?;
        request.expected_source = Some(metadata.source.clone());
        request.expected_revision = Some(metadata.revision.clone());
        let size = metadata.size;
        let reader = self.clone();
        let expected = metadata.clone();
        let rest = stream::iter((PREVIEW_CHUNK_BYTES as u64..size).step_by(PREVIEW_CHUNK_BYTES))
            .map(move |offset| {
                let reader = reader.clone();
                let expected = expected.clone();
                let mut request = request.clone();
                request.offset = offset;
                async move {
                    let (resource, bytes) = reader.read(&request).await?;
                    if !same_resource(&resource, &expected) {
                        return Err(HtmlPreviewError::unavailable(
                            "HTML preview resource changed during transfer",
                        ));
                    }
                    Ok(bytes)
                }
            })
            .buffered(PREFETCH_CHUNKS);
        let chunks = stream::once(async move { Ok(first) }).chain(rest).boxed();
        let transfer = self.clone();
        let cache_metadata = metadata.clone();
        let collect = (size <= CACHE_RESOURCE_BYTES).then(Vec::new);
        let body = stream::try_unfold(
            (chunks, collect, 0_u64, permit, load_guard),
            move |(mut chunks, mut collect, mut received, permit, load_guard)| {
                let transfer = transfer.clone();
                let key = key.clone();
                let metadata = cache_metadata.clone();
                async move {
                    let next = transfer
                        .while_open(async { chunks.next().await.transpose() })
                        .await?;
                    let Some(bytes) = next else {
                        return Ok(None);
                    };
                    received += bytes.len() as u64;
                    if let Some(collected) = &mut collect {
                        collected.push(bytes.clone());
                    }
                    // Only complete, validated resources enter the cache. No
                    // detached prefetch task survives a dropped HTTP response.
                    if received == size {
                        if let Some(collected) = collect.take() {
                            transfer
                                .cache
                                .lock()
                                .unwrap()
                                .insert(key, metadata, collected);
                        }
                    }
                    Ok(Some((
                        bytes,
                        (chunks, collect, received, permit, load_guard),
                    )))
                }
            },
        )
        .boxed();
        Ok(PreviewResource { metadata, body })
    }
}

fn same_resource(first: &HtmlPreviewResource, next: &HtmlPreviewResource) -> bool {
    first.source == next.source
        && first.revision == next.revision
        && first.size == next.size
        && first.resource_path == next.resource_path
        && first.entry_path == next.entry_path
        && first.mime_type == next.mime_type
}

fn closed_error() -> HtmlPreviewError {
    HtmlPreviewError::unavailable("HTML preview is no longer available")
}

fn validate_chunk(
    file: &HtmlPreviewResource,
    request: &HtmlPreviewResourceRequest,
) -> Result<Vec<u8>, HtmlPreviewError> {
    if file.size > MAX_PREVIEW_BYTES
        || file.offset != request.offset
        || file.offset > file.size
        || file.source.is_empty()
        || file.revision.is_empty()
        || request
            .expected_source
            .as_ref()
            .is_some_and(|source| source != &file.source)
        || request
            .expected_revision
            .as_ref()
            .is_some_and(|revision| revision != &file.revision)
        || file.content_base64.len() > PREVIEW_CHUNK_BYTES.div_ceil(3) * 4
    {
        return Err(HtmlPreviewError::unavailable(
            "Invalid HTML preview resource chunk",
        ));
    }
    let bytes = BASE64
        .decode(&file.content_base64)
        .map_err(|_| HtmlPreviewError::unavailable("Invalid HTML preview resource encoding"))?;
    let expected = if request.metadata_only {
        0
    } else {
        (file.size - file.offset).min(PREVIEW_CHUNK_BYTES as u64) as usize
    };
    if bytes.len() != expected {
        return Err(HtmlPreviewError::unavailable(
            "Incomplete HTML preview resource chunk",
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
pub(crate) mod tests;
