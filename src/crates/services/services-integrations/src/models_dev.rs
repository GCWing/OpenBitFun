//! models.dev source loading and last-valid snapshot persistence.
//!
//! This module deliberately exposes the source document as JSON text. The
//! provider-specific interpretation belongs to `openbitfun-ai-adapters`, which is
//! above this integration layer in the repository dependency graph.
//!
//! `OPENBITFUN_MODELS_DEV_PATH` selects a local JSON file as the runtime refresh
//! source for development and testing. When it is not set,
//! `OPENBITFUN_MODELS_DEV_URL` selects the HTTP source.

use log::{debug, warn};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tokio::fs;
use tokio::sync::Mutex;

pub const DEFAULT_MODELS_DEV_ENDPOINT: &str = "https://models.dev/api.json";
const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const MIN_REFRESH_ATTEMPT_INTERVAL: Duration = Duration::from_secs(5 * 60);
const MAX_REFRESH_ATTEMPTS: usize = 3;
const BUNDLED_MODELS_DEV_SNAPSHOT: &str = include_str!("../assets/models-dev.json");
const MODELS_DEV_PATH_ENV: &str = "OPENBITFUN_MODELS_DEV_PATH";
const MODELS_DEV_URL_ENV: &str = "OPENBITFUN_MODELS_DEV_URL";

#[derive(Debug, Default)]
struct RefreshState {
    last_attempt: Option<Instant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    length: u64,
    modified: SystemTime,
}

#[derive(Debug)]
struct ValidatedSnapshot {
    stamp: Option<FileStamp>,
    cache_valid: bool,
    snapshot: ModelsDevSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelsDevSnapshotSource {
    Cache,
    Bundled,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelsDevSnapshot {
    pub body: String,
    pub source: ModelsDevSnapshotSource,
    pub version: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelsDevCacheMetadata {
    pub path: PathBuf,
    pub exists: bool,
    pub updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelsDevRefreshOutcome {
    NotNeeded,
    Throttled,
    Unchanged { version: u64 },
    Updated(ModelsDevSnapshot),
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ModelsDevRuntimeSource {
    Http(String),
    LocalFile(PathBuf),
}

#[derive(Debug, Clone)]
pub struct ModelsDevCatalogService {
    cache_file: PathBuf,
    runtime_source: ModelsDevRuntimeSource,
    bundled_snapshot: Arc<str>,
    cache_ttl: Duration,
    refresh_state: Arc<Mutex<RefreshState>>,
    refresh_in_progress: Arc<AtomicBool>,
    validated_snapshot: Arc<Mutex<Option<ValidatedSnapshot>>>,
}

struct RefreshGuard(Arc<AtomicBool>);

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl ModelsDevCatalogService {
    pub fn new(cache_file: impl Into<PathBuf>) -> Self {
        Self {
            cache_file: cache_file.into(),
            runtime_source: runtime_source_from_environment(),
            bundled_snapshot: Arc::from(BUNDLED_MODELS_DEV_SNAPSHOT),
            cache_ttl: DEFAULT_CACHE_TTL,
            refresh_state: Arc::new(Mutex::new(RefreshState::default())),
            refresh_in_progress: Arc::new(AtomicBool::new(false)),
            validated_snapshot: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(test)]
    fn with_bundled_snapshot(mut self, snapshot: impl Into<Arc<str>>) -> Self {
        self.bundled_snapshot = snapshot.into();
        self
    }

    #[cfg(test)]
    fn with_endpoint(mut self, endpoint_url: impl Into<String>) -> Self {
        self.runtime_source = ModelsDevRuntimeSource::Http(endpoint_url.into());
        self
    }

    #[cfg(test)]
    fn with_local_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.runtime_source = ModelsDevRuntimeSource::LocalFile(path.into());
        self
    }

    #[cfg(test)]
    fn with_cache_ttl(mut self, cache_ttl: Duration) -> Self {
        self.cache_ttl = cache_ttl;
        self
    }

    /// Load the best immediately available source without contacting the network.
    pub async fn load_cached_or_bundled(&self) -> ModelsDevSnapshot {
        // Share cold reads across consumers. A timestamp controls revalidation,
        // never the lifetime of the last valid document.
        let mut cached = self.validated_snapshot.lock().await;
        let stamp = self.file_stamp().await;
        if let Some(cached) = cached.as_ref().filter(|cached| cached.stamp == stamp) {
            return cached.snapshot.clone();
        }
        if let Ok(body) = fs::read_to_string(&self.cache_file).await {
            if let Some(snapshot) = checked_snapshot(body, ModelsDevSnapshotSource::Cache).await {
                *cached = Some(ValidatedSnapshot {
                    stamp,
                    cache_valid: true,
                    snapshot: snapshot.clone(),
                });
                return snapshot;
            }
            debug!(
                "Ignoring invalid models.dev cache at {}",
                self.cache_file.display()
            );
        }

        let snapshot = match cached.as_ref() {
            Some(cached) => cached.snapshot.clone(),
            None => checked_snapshot(
                self.bundled_snapshot.to_string(),
                ModelsDevSnapshotSource::Bundled,
            )
            .await
            .unwrap_or_else(|| snapshot("{}".to_string(), ModelsDevSnapshotSource::Empty)),
        };
        *cached = Some(ValidatedSnapshot {
            stamp,
            cache_valid: false,
            snapshot: snapshot.clone(),
        });
        snapshot
    }

    async fn file_stamp(&self) -> Option<FileStamp> {
        let metadata = fs::metadata(&self.cache_file).await.ok()?;
        Some(FileStamp {
            length: metadata.len(),
            modified: metadata.modified().ok()?,
        })
    }

    pub async fn cache_metadata(&self) -> ModelsDevCacheMetadata {
        let metadata = fs::metadata(&self.cache_file).await.ok();
        let updated_at_ms = metadata
            .as_ref()
            .and_then(|value| value.modified().ok())
            .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|value| value.as_millis().min(i64::MAX as u128) as i64);
        ModelsDevCacheMetadata {
            path: self.cache_file.clone(),
            exists: metadata.is_some(),
            updated_at_ms,
        }
    }

    pub fn refresh_in_progress(&self) -> bool {
        self.refresh_in_progress.load(Ordering::Acquire)
    }

    /// Refresh the cache when stale. Failures leave the last valid cache intact.
    pub async fn refresh_if_stale(&self) -> ModelsDevRefreshOutcome {
        self.refresh(false).await
    }

    /// Refresh the cache immediately, bypassing the freshness check. The
    /// existing refresh-attempt throttle still prevents concurrent/repeated
    /// requests from becoming an update storm.
    pub async fn refresh_now(&self) -> ModelsDevRefreshOutcome {
        self.refresh(true).await
    }

    async fn refresh(&self, force: bool) -> ModelsDevRefreshOutcome {
        if self
            .refresh_in_progress
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return ModelsDevRefreshOutcome::Throttled;
        }
        let _refresh_guard = RefreshGuard(self.refresh_in_progress.clone());
        let incoming = match &self.runtime_source {
            ModelsDevRuntimeSource::LocalFile(path) => {
                let body = match fs::read_to_string(path).await {
                    Ok(body) => body,
                    Err(error) => {
                        warn!(
                            "Failed to read local models.dev catalog at {}: {}",
                            path.display(),
                            error
                        );
                        return ModelsDevRefreshOutcome::Failed;
                    }
                };
                let Some(incoming) = checked_snapshot(body, ModelsDevSnapshotSource::Cache).await
                else {
                    warn!(
                        "Local models.dev catalog at {} failed schema validation",
                        path.display()
                    );
                    return ModelsDevRefreshOutcome::Failed;
                };
                if self.cache_matches(&incoming.body).await {
                    return ModelsDevRefreshOutcome::NotNeeded;
                }
                incoming
            }
            ModelsDevRuntimeSource::Http(endpoint_url) => {
                if endpoint_url.trim().is_empty() {
                    return ModelsDevRefreshOutcome::NotNeeded;
                }
                if !force && self.is_cache_fresh().await {
                    return ModelsDevRefreshOutcome::NotNeeded;
                }
                let Ok(mut refresh_state) = self.refresh_state.try_lock() else {
                    return ModelsDevRefreshOutcome::Throttled;
                };
                let now = Instant::now();
                if refresh_state.last_attempt.is_some_and(|last_attempt| {
                    now.duration_since(last_attempt) < MIN_REFRESH_ATTEMPT_INTERVAL
                }) {
                    return ModelsDevRefreshOutcome::Throttled;
                }
                refresh_state.last_attempt = Some(now);
                drop(refresh_state);

                let client = match crate::reqwest_client_builder()
                    .timeout(Duration::from_secs(10))
                    .build()
                {
                    Ok(client) => client,
                    Err(error) => {
                        warn!("Failed to create models.dev HTTP client: {}", error);
                        return ModelsDevRefreshOutcome::Failed;
                    }
                };
                let mut body = None;
                for attempt in 0..MAX_REFRESH_ATTEMPTS {
                    match fetch_catalog_body(&client, endpoint_url).await {
                        Ok(value) => {
                            body = Some(value);
                            break;
                        }
                        Err(error)
                            if error.is_retryable() && attempt + 1 < MAX_REFRESH_ATTEMPTS =>
                        {
                            warn!(
                                "models.dev catalog refresh attempt {}/{} failed: {}; retrying",
                                attempt + 1,
                                MAX_REFRESH_ATTEMPTS,
                                error
                            );
                            tokio::time::sleep(retry_backoff(attempt)).await;
                        }
                        Err(error) => {
                            warn!(
                                "models.dev catalog refresh failed after {} attempt(s): {}",
                                attempt + 1,
                                error
                            );
                            break;
                        }
                    }
                }
                let Some(body) = body else {
                    return ModelsDevRefreshOutcome::Failed;
                };
                body
            }
        };

        let previous = self.load_cached_or_bundled().await;

        match self.write_cache_atomically(&incoming.body).await {
            Ok(()) => {
                let stamp = self.file_stamp().await;
                *self.validated_snapshot.lock().await = Some(ValidatedSnapshot {
                    stamp,
                    cache_valid: true,
                    snapshot: incoming.clone(),
                });
                if previous.sha256 == incoming.sha256 {
                    ModelsDevRefreshOutcome::Unchanged {
                        version: incoming.version,
                    }
                } else {
                    ModelsDevRefreshOutcome::Updated(incoming)
                }
            }
            Err(error) => {
                warn!(
                    "Failed to persist models.dev catalog at {}: {}",
                    self.cache_file.display(),
                    error
                );
                ModelsDevRefreshOutcome::Failed
            }
        }
    }

    async fn is_cache_fresh(&self) -> bool {
        let Some(stamp) = self.file_stamp().await else {
            return false;
        };
        let age = SystemTime::now()
            .duration_since(stamp.modified)
            .unwrap_or_default();
        if age >= self.cache_ttl {
            return false;
        }
        // Only a document that was validated at this exact file revision is fresh.
        self.load_cached_or_bundled().await;
        self.validated_snapshot
            .lock()
            .await
            .as_ref()
            .is_some_and(|cached| cached.cache_valid && cached.stamp.as_ref() == Some(&stamp))
    }

    async fn cache_matches(&self, expected: &str) -> bool {
        fs::read_to_string(&self.cache_file)
            .await
            .is_ok_and(|body| is_valid_catalog_document(&body) && body == expected)
    }

    async fn write_cache_atomically(&self, body: &str) -> std::io::Result<()> {
        if let Some(parent) = self.cache_file.parent() {
            fs::create_dir_all(parent).await?;
        }
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temp_file = self.cache_file.with_file_name(format!(
            ".{}.{}.{}.tmp",
            self.cache_file
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("models-dev"),
            std::process::id(),
            nonce
        ));
        fs::write(&temp_file, body).await?;
        #[cfg(not(windows))]
        let replacement = fs::rename(&temp_file, &self.cache_file).await;
        #[cfg(windows)]
        let replacement = replace_cache_file_atomically(&temp_file, &self.cache_file);

        match replacement {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&temp_file).await;
                Err(error)
            }
        }
    }
}

async fn checked_snapshot(
    body: String,
    source: ModelsDevSnapshotSource,
) -> Option<ModelsDevSnapshot> {
    tokio::task::spawn_blocking(move || {
        is_valid_catalog_document(&body).then(|| snapshot(body, source))
    })
    .await
    .ok()
    .flatten()
}

fn runtime_source_from_environment() -> ModelsDevRuntimeSource {
    runtime_source_from_values(
        std::env::var(MODELS_DEV_PATH_ENV).ok(),
        std::env::var(MODELS_DEV_URL_ENV).ok(),
    )
}

fn runtime_source_from_values(
    local_path: Option<String>,
    endpoint_url: Option<String>,
) -> ModelsDevRuntimeSource {
    if let Some(local_path) = local_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return ModelsDevRuntimeSource::LocalFile(PathBuf::from(local_path));
    }

    ModelsDevRuntimeSource::Http(
        endpoint_url
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_MODELS_DEV_ENDPOINT.to_string()),
    )
}

#[cfg(windows)]
fn replace_cache_file_atomically(
    temp_path: &std::path::Path,
    target_path: &std::path::Path,
) -> std::io::Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
    };

    let temp = windows_extended_path(temp_path)?;
    let target = windows_extended_path(target_path)?;
    let result = unsafe {
        if target_path.exists() {
            ReplaceFileW(
                PCWSTR(target.as_ptr()),
                PCWSTR(temp.as_ptr()),
                PCWSTR::null(),
                REPLACEFILE_WRITE_THROUGH,
                None,
                None,
            )
        } else {
            MoveFileExW(
                PCWSTR(temp.as_ptr()),
                PCWSTR(target.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    result.map_err(|error| std::io::Error::other(error.to_string()))
}

#[cfg(windows)]
fn windows_extended_path(path: &std::path::Path) -> std::io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;

    let absolute = std::path::absolute(path)?;
    let path = absolute.as_os_str().encode_wide().collect::<Vec<_>>();
    let slash = b'\\' as u16;
    let mut extended = if path.starts_with(&[slash, slash, b'?' as u16, slash])
        || path.starts_with(&[slash, slash, b'.' as u16, slash])
    {
        path
    } else if path.starts_with(&[slash, slash]) {
        r"\\?\UNC\"
            .encode_utf16()
            .chain(path.into_iter().skip(2))
            .collect()
    } else if path.len() >= 3 && path[1] == b':' as u16 && path[2] == slash {
        r"\\?\".encode_utf16().chain(path).collect()
    } else {
        path
    };
    extended.push(0);
    Ok(extended)
}

#[derive(Debug)]
enum RefreshError {
    Request(reqwest::Error),
    Status(reqwest::StatusCode),
    InvalidDocument,
    ResponseBody(reqwest::Error),
}

impl RefreshError {
    fn is_retryable(&self) -> bool {
        match self {
            Self::Request(error) | Self::ResponseBody(error) => {
                error.is_connect() || error.is_timeout() || error.is_request() || error.is_body()
            }
            Self::Status(status) => {
                status.is_server_error() || matches!(status.as_u16(), 408 | 429)
            }
            Self::InvalidDocument => false,
        }
    }
}

impl std::fmt::Display for RefreshError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Request(error) => write!(formatter, "request error: {error}"),
            Self::Status(status) => write!(formatter, "HTTP {status}"),
            Self::InvalidDocument => write!(formatter, "response failed schema validation"),
            Self::ResponseBody(error) => write!(formatter, "response body error: {error}"),
        }
    }
}

async fn fetch_catalog_body(
    client: &reqwest::Client,
    endpoint_url: &str,
) -> Result<ModelsDevSnapshot, RefreshError> {
    let response = client
        .get(endpoint_url)
        .send()
        .await
        .map_err(RefreshError::Request)?;
    let status = response.status();
    if !status.is_success() {
        return Err(RefreshError::Status(status));
    }
    let body = response.text().await.map_err(RefreshError::ResponseBody)?;
    checked_snapshot(body, ModelsDevSnapshotSource::Cache)
        .await
        .ok_or(RefreshError::InvalidDocument)
}

fn retry_backoff(attempt: usize) -> Duration {
    match attempt {
        0 => Duration::from_millis(100),
        _ => Duration::from_millis(250),
    }
}

fn snapshot(body: String, source: ModelsDevSnapshotSource) -> ModelsDevSnapshot {
    let digest = sha256_hex(body.as_bytes());
    let version = digest
        .get(..16)
        .and_then(|prefix| u64::from_str_radix(prefix, 16).ok())
        .unwrap_or(0);
    ModelsDevSnapshot {
        body,
        source,
        version,
        sha256: digest,
    }
}

fn sha256_hex(body: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(body);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_valid_catalog_document(body: &str) -> bool {
    let Ok(serde_json::Value::Object(providers)) = serde_json::from_str(body) else {
        return false;
    };
    providers.iter().any(|(provider_id, provider)| {
        !provider_id.trim().is_empty()
            && provider
                .get("models")
                .and_then(serde_json::Value::as_object)
                .is_some_and(|models| {
                    models.iter().any(|(model_id, model)| {
                        !model_id.trim().is_empty()
                            && model
                                .get("id")
                                .and_then(serde_json::Value::as_str)
                                .is_some_and(|id| !id.trim().is_empty())
                    })
                })
    })
}

#[cfg(test)]
mod tests {
    use super::{
        runtime_source_from_values, ModelsDevCatalogService, ModelsDevRefreshOutcome,
        ModelsDevRuntimeSource, ModelsDevSnapshotSource,
    };
    use std::path::PathBuf;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const VALID: &str = r#"{"openai":{"id":"openai","name":"OpenAI","models":{"gpt-test":{"id":"gpt-test","name":"GPT Test"}}}}"#;

    #[tokio::test]
    async fn cache_is_preferred_over_bundled_snapshot() {
        let directory = tempfile::tempdir().expect("temp directory");
        let cache_file = directory.path().join("models.json");
        tokio::fs::write(&cache_file, VALID)
            .await
            .expect("cache write");
        let service = ModelsDevCatalogService::new(&cache_file)
            .with_bundled_snapshot(r#"{"anthropic":{"models":{"other":{"id":"other"}}}}"#);

        let snapshot = service.load_cached_or_bundled().await;

        assert_eq!(snapshot.source, ModelsDevSnapshotSource::Cache);
        assert!(snapshot.body.contains("gpt-test"));
    }

    #[tokio::test]
    async fn loaded_snapshot_survives_corruption_and_observes_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("catalog.json");
        tokio::fs::write(&file, VALID).await.unwrap();
        let service = ModelsDevCatalogService::new(&file);
        let first = service.load_cached_or_bundled().await;
        assert!(service.is_cache_fresh().await);
        tokio::fs::write(&file, "invalid").await.unwrap();
        assert_eq!(service.load_cached_or_bundled().await, first);
        assert!(!service.is_cache_fresh().await);
        tokio::fs::remove_file(&file).await.unwrap();
        assert_eq!(service.load_cached_or_bundled().await, first);
        tokio::fs::write(
            &file,
            r#"{"provider":{"models":{"replacement":{"id":"replacement"}}}}"#,
        )
        .await
        .unwrap();
        assert_ne!(service.load_cached_or_bundled().await.sha256, first.sha256);
        assert!(service.is_cache_fresh().await);
    }

    #[tokio::test]
    async fn invalid_cache_falls_back_to_bundled_snapshot() {
        let directory = tempfile::tempdir().expect("temp directory");
        let cache_file = directory.path().join("models.json");
        tokio::fs::write(&cache_file, "not json")
            .await
            .expect("cache write");
        let service = ModelsDevCatalogService::new(&cache_file)
            .with_bundled_snapshot(VALID)
            .with_endpoint("")
            .with_cache_ttl(Duration::ZERO);

        let snapshot = service.load_cached_or_bundled().await;

        assert_eq!(snapshot.source, ModelsDevSnapshotSource::Bundled);
        assert!(snapshot.body.contains("gpt-test"));
        assert_eq!(
            service.refresh_if_stale().await,
            ModelsDevRefreshOutcome::NotNeeded
        );
    }

    #[tokio::test]
    async fn atomic_cache_write_leaves_a_valid_document() {
        let directory = tempfile::tempdir().expect("temp directory");
        let cache_file = directory.path().join("nested").join("models.json");
        let service = ModelsDevCatalogService::new(&cache_file).with_endpoint("");

        tokio::fs::create_dir_all(cache_file.parent().expect("cache parent"))
            .await
            .expect("cache parent creation");
        tokio::fs::write(
            &cache_file,
            r#"{"openai":{"models":{"gpt-old":{"id":"gpt-old"}}}}"#,
        )
        .await
        .expect("existing cache write");

        service
            .write_cache_atomically(VALID)
            .await
            .expect("atomic write");
        let snapshot = service.load_cached_or_bundled().await;

        assert_eq!(snapshot.source, ModelsDevSnapshotSource::Cache);
        assert_eq!(snapshot.body, VALID);
        assert!(!cache_file.with_extension("tmp").exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn failed_windows_replacement_preserves_the_existing_cache() {
        let directory = tempfile::tempdir().expect("temp directory");
        let cache_file = directory.path().join("models.json");
        let missing_temp_file = directory.path().join("missing.tmp");
        tokio::fs::write(&cache_file, VALID)
            .await
            .expect("existing cache write");

        super::replace_cache_file_atomically(&missing_temp_file, &cache_file)
            .expect_err("missing replacement should fail");

        assert_eq!(
            tokio::fs::read_to_string(cache_file)
                .await
                .expect("preserved cache read"),
            VALID
        );
    }

    #[test]
    fn local_runtime_source_takes_precedence_over_http_source() {
        assert_eq!(
            runtime_source_from_values(
                Some(" E:/tmp/models-dev.json ".to_string()),
                Some("https://example.com/models.json".to_string()),
            ),
            ModelsDevRuntimeSource::LocalFile(PathBuf::from("E:/tmp/models-dev.json"))
        );
    }

    #[tokio::test]
    async fn local_runtime_source_replaces_a_fresh_cache() {
        let directory = tempfile::tempdir().expect("temp directory");
        let cache_file = directory.path().join("models.json");
        let source_file = directory.path().join("local-models.json");
        tokio::fs::write(
            &cache_file,
            r#"{"openai":{"models":{"gpt-old":{"id":"gpt-old"}}}}"#,
        )
        .await
        .expect("existing cache write");
        tokio::fs::write(&source_file, VALID)
            .await
            .expect("local source write");
        let service = ModelsDevCatalogService::new(&cache_file).with_local_file(&source_file);

        let outcome = service.refresh_if_stale().await;

        let ModelsDevRefreshOutcome::Updated(snapshot) = outcome else {
            panic!("local source should update the cache");
        };
        assert_eq!(snapshot.source, ModelsDevSnapshotSource::Cache);
        assert_eq!(snapshot.body, VALID);
        assert_eq!(
            tokio::fs::read_to_string(cache_file)
                .await
                .expect("updated cache read"),
            VALID
        );
    }

    #[tokio::test]
    async fn refresh_now_bypasses_fresh_cache_for_http_source() {
        let directory = tempfile::tempdir().expect("temp directory");
        let cache_file = directory.path().join("models.json");
        tokio::fs::write(&cache_file, VALID)
            .await
            .expect("existing cache write");
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("request");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        VALID.len(),
                        VALID
                    )
                    .as_bytes(),
                )
                .await
                .expect("response");
        });
        let service = ModelsDevCatalogService::new(&cache_file)
            .with_endpoint(format!("http://{address}"))
            .with_cache_ttl(Duration::from_secs(3600));

        assert_eq!(
            service.refresh_if_stale().await,
            ModelsDevRefreshOutcome::NotNeeded
        );
        assert_eq!(
            service.refresh_now().await,
            ModelsDevRefreshOutcome::Unchanged {
                version: super::snapshot(VALID.to_string(), ModelsDevSnapshotSource::Cache).version
            }
        );
        server.await.expect("server");
    }

    #[tokio::test]
    async fn invalid_local_runtime_source_preserves_the_last_valid_cache() {
        let directory = tempfile::tempdir().expect("temp directory");
        let cache_file = directory.path().join("models.json");
        let source_file = directory.path().join("local-models.json");
        tokio::fs::write(&cache_file, VALID)
            .await
            .expect("existing cache write");
        tokio::fs::write(&source_file, "not json")
            .await
            .expect("invalid local source write");
        let service = ModelsDevCatalogService::new(&cache_file).with_local_file(&source_file);

        let outcome = service.refresh_if_stale().await;

        assert_eq!(outcome, ModelsDevRefreshOutcome::Failed);
        assert_eq!(
            tokio::fs::read_to_string(cache_file)
                .await
                .expect("preserved cache read"),
            VALID
        );
    }

    #[tokio::test]
    async fn transient_refresh_failures_are_retried_with_a_bounded_attempt_count() {
        let directory = tempfile::tempdir().expect("temp directory");
        let cache_file = directory.path().join("models.json");
        let (endpoint, attempts, server) =
            spawn_http_server(vec![(500, ""), (503, ""), (200, VALID)]).await;
        let service = ModelsDevCatalogService::new(&cache_file)
            .with_endpoint(endpoint)
            .with_cache_ttl(Duration::ZERO);

        let outcome = service.refresh_if_stale().await;

        assert!(matches!(outcome, ModelsDevRefreshOutcome::Updated(_)));
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        server.await.expect("test server should finish");
    }

    #[tokio::test]
    async fn unchanged_refresh_does_not_report_a_catalog_update() {
        let directory = tempfile::tempdir().expect("temp directory");
        let cache_file = directory.path().join("models.json");
        tokio::fs::write(&cache_file, VALID)
            .await
            .expect("existing cache write");
        let (endpoint, attempts, server) = spawn_http_server(vec![(200, VALID)]).await;
        let service = ModelsDevCatalogService::new(&cache_file)
            .with_endpoint(endpoint)
            .with_cache_ttl(Duration::ZERO);

        let outcome = service.refresh_if_stale().await;

        assert!(matches!(outcome, ModelsDevRefreshOutcome::Unchanged { .. }));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        server.await.expect("test server should finish");
    }

    async fn spawn_http_server(
        responses: Vec<(u16, &str)>,
    ) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test server should bind");
        let address = listener.local_addr().expect("test server address");
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_for_task = attempts.clone();
        let responses = responses
            .into_iter()
            .map(|(status, body)| (status, body.to_string()))
            .collect::<Vec<_>>();
        let task = tokio::spawn(async move {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().await.expect("test request");
                attempts_for_task.fetch_add(1, Ordering::SeqCst);
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request).await;
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("test response");
            }
        });
        (format!("http://{address}/models.json"), attempts, task)
    }
}
