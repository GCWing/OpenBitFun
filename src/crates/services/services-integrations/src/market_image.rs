//! Persistent cache for public, content-addressed marketplace WebP images.
//! Hosts supply their cache directory; no workspace or account data is cached.

use reqwest::{header, Url};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tokio::sync::{Mutex, Semaphore};

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const CACHE_BUDGET_BYTES: u64 = 256 * 1024 * 1024;

pub struct MarketImageCache {
    root: PathBuf,
    prefixes: Vec<String>,
    client: reqwest::Client,
    downloads: Semaphore,
    writer: Mutex<()>,
}

impl MarketImageCache {
    pub fn new(root: PathBuf, miniapp_api: &str) -> Result<Self, String> {
        let url = Url::parse(miniapp_api).map_err(|error| error.to_string())?;
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Marketplace image origins must use HTTPS or loopback HTTP.".into());
        }
        let prefixes = vec![format!(
            "{}/screenshots/",
            url.as_str().trim_end_matches('/')
        )];
        let client = crate::reqwest_client_builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            root,
            prefixes,
            client,
            downloads: Semaphore::new(4),
            writer: Mutex::new(()),
        })
    }

    fn image_url(&self, source: &str) -> Result<Url, String> {
        let url = Url::parse(source).map_err(|error| error.to_string())?;
        let mut path = url.clone();
        path.set_query(None);
        if url.fragment().is_some()
            || !self.prefixes.iter().any(|prefix| {
                path.as_str().strip_prefix(prefix).is_some_and(|hash| {
                    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
            })
        {
            return Err(
                "Only public images from the configured marketplaces can be cached.".into(),
            );
        }
        let query: Vec<_> = url.query_pairs().collect();
        if query.len() > 1
            || query.iter().any(|(key, value)| {
                key != "variant" || !matches!(value.as_ref(), "compact-v1" | "large-v1")
            })
        {
            return Err("Unsupported marketplace image variant.".into());
        }
        Ok(url)
    }

    pub async fn load(&self, source: &str) -> Result<Vec<u8>, String> {
        let url = self.image_url(source)?;
        // Include the origin and variant: separate deployments and resolutions
        // must never alias, even when they reference the same source hash.
        let key = hex::encode(Sha256::digest(url.as_str().as_bytes()));
        let path = self.root.join(format!("{key}.webp"));
        if let Some(bytes) = read_cached(&path).await {
            return Ok(bytes);
        }

        let _permit = self
            .downloads
            .acquire()
            .await
            .map_err(|error| error.to_string())?;
        if let Some(bytes) = read_cached(&path).await {
            return Ok(bytes);
        }
        let mut response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;
        if response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.split(';').next().unwrap_or("").trim())
            != Some("image/webp")
            || response
                .content_length()
                .is_some_and(|size| size > MAX_IMAGE_BYTES as u64)
        {
            return Err("Marketplace image response has an unsupported type or size.".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            if bytes.len() + chunk.len() > MAX_IMAGE_BYTES {
                return Err("Marketplace image exceeds the cache size limit.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if !is_webp(&bytes) {
            return Err("Marketplace returned an invalid WebP image.".into());
        }

        // An unavailable/full cache must not hide a successfully fetched image.
        let _writer = self.writer.lock().await;
        if let Err(error) = self.store(&path, &bytes).await {
            log::warn!("Failed to persist marketplace image cache: {error}");
        }
        Ok(bytes)
    }

    async fn store(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        tokio::fs::create_dir_all(&self.root).await?;
        let temporary = self.root.join(format!("{}.part", uuid::Uuid::new_v4()));
        if let Err(error) = async {
            tokio::fs::write(&temporary, bytes).await?;
            tokio::fs::rename(&temporary, path).await
        }
        .await
        {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        prune_cache(&self.root, path, CACHE_BUDGET_BYTES).await
    }
}

fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12
        && bytes.starts_with(b"RIFF")
        && &bytes[8..12] == b"WEBP"
        && u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8 == bytes.len()
}

async fn read_cached(path: &Path) -> Option<Vec<u8>> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES as u64 {
        return None;
    }
    let bytes = tokio::fs::read(path).await.ok()?;
    is_webp(&bytes).then_some(bytes)
}

async fn prune_cache(root: &Path, keep: &Path, budget: u64) -> std::io::Result<()> {
    let mut directory = tokio::fs::read_dir(root).await?;
    let mut entries = Vec::new();
    let mut total = 0;
    while let Some(entry) = directory.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("webp") {
            continue;
        }
        let metadata = entry.metadata().await?;
        if metadata.is_file() {
            total += metadata.len();
            entries.push((
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                path,
                metadata.len(),
            ));
        }
    }
    entries.sort_by_key(|(modified, _, _)| *modified);
    for (_, path, size) in entries {
        if total <= budget {
            break;
        }
        if path != keep {
            tokio::fs::remove_file(path).await?;
            total -= size;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn webp() -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut bytes, image::ImageFormat::WebP)
            .unwrap();
        bytes.into_inner()
    }

    async fn serve_once(body: Vec<u8>, headers: &str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let headers = headers.to_string();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let count = stream.read(&mut request).await.unwrap();
            let head = format!(
                "HTTP/1.1 200 OK\r\n{headers}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
            String::from_utf8_lossy(&request[..count]).into_owned()
        });
        (base, task)
    }

    #[tokio::test]
    async fn cached_images_survive_a_new_client_with_the_server_offline() {
        let storage = tempfile::tempdir().unwrap();
        let bytes = webp();
        let (base, server) = serve_once(bytes.clone(), "Content-Type: image/webp").await;
        let source = format!("{base}/screenshots/{}?variant=compact-v1", "a".repeat(64));
        let cache = MarketImageCache::new(storage.path().into(), &base).unwrap();
        assert_eq!(cache.load(&source).await.unwrap(), bytes);
        assert!(server.await.unwrap().contains("variant=compact-v1"));
        drop(cache);
        let restarted = MarketImageCache::new(storage.path().into(), &base).unwrap();
        assert_eq!(restarted.load(&source).await.unwrap(), bytes);
        // A different resolution cannot accidentally consume the compact entry.
        assert!(restarted
            .load(&source.replace("compact-v1", "large-v1"))
            .await
            .is_err());
    }

    #[test]
    fn rejects_arbitrary_origins_paths_and_personalized_urls() {
        let cache = MarketImageCache::new(PathBuf::new(), "https://market.test/miniapp/api/v1")
            .unwrap();
        let path = format!("/miniapp/api/v1/screenshots/{}", "a".repeat(64));
        assert!(cache
            .image_url(&format!("https://market.test{path}"))
            .is_ok());
        for source in [
            format!("https://market.test.evil{path}"),
            format!("http://market.test{path}"),
            format!("https://market.test{path}?token=secret"),
            format!("https://market.test{path}?variant=other"),
            format!("https://market.test{path}?variant=compact-v1&variant=large-v1"),
            format!("https://market.test{path}#fragment"),
            "https://market.test/miniapp/api/v1/screenshots/../listings".into(),
            "file:///etc/passwd".into(),
        ] {
            assert!(cache.image_url(&source).is_err(), "accepted {source}");
        }
    }

    #[tokio::test]
    async fn rejects_invalid_downloads_and_recovers_from_incomplete_cache_files() {
        let storage = tempfile::tempdir().unwrap();
        let bytes = webp();
        let (base, server) = serve_once(bytes.clone(), "Content-Type: image/webp").await;
        let source = format!("{base}/screenshots/{}", "c".repeat(64));
        let key = hex::encode(Sha256::digest(source.as_bytes()));
        tokio::fs::write(storage.path().join(format!("{key}.webp")), &bytes[..12])
            .await
            .unwrap();
        let cache = MarketImageCache::new(storage.path().into(), &base).unwrap();
        assert_eq!(cache.load(&source).await.unwrap(), bytes);
        server.await.unwrap();

        let (base, server) = serve_once(b"error page".to_vec(), "Content-Type: image/webp").await;
        let cache = MarketImageCache::new(storage.path().into(), &base).unwrap();
        assert!(cache
            .load(&format!("{base}/screenshots/{}", "d".repeat(64)))
            .await
            .is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn pruning_keeps_the_new_image_and_stays_within_budget() {
        let storage = tempfile::tempdir().unwrap();
        let keep = storage.path().join("new.webp");
        tokio::fs::write(storage.path().join("old.webp"), vec![0; 20])
            .await
            .unwrap();
        tokio::fs::write(&keep, vec![0; 20]).await.unwrap();
        prune_cache(storage.path(), &keep, 20).await.unwrap();
        assert!(!storage.path().join("old.webp").exists());
        assert!(keep.exists());
    }
}
