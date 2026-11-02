//! OpenBitFun Page incremental upload client (Save Version → Deploy).

use anyhow::{anyhow, Result};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::remote_connect::relay_http::{relay_http_client, send_with_retry, RelayHttpRetry};

const MAX_UPLOAD_BATCH_BASE64_BYTES: usize = 256 * 1024;
const MAX_PAGE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_PAGE_FILES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct PageUploadManifestEntry {
    path: String,
    hash: String,
    size: u64,
}

#[derive(Debug)]
struct CollectedPageFile {
    rel_path: String,
    content: Vec<u8>,
    hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadSessionMode {
    ManifestBound,
    LegacyRelay,
}

fn validate_upload_session_echo(
    response: &serde_json::Value,
    expected_upload_id: &str,
) -> Result<UploadSessionMode> {
    match response
        .get("upload_id")
        .and_then(serde_json::Value::as_str)
    {
        Some(actual) if actual == expected_upload_id => Ok(UploadSessionMode::ManifestBound),
        Some(_) => Err(anyhow!("check-files returned a mismatched upload session")),
        // Relays predating manifest-bound upload sessions ignore the request's
        // unknown `upload_id` field and omit it from the response. Their upload
        // and freeze DTOs likewise ignore the extra field, so retaining the
        // legacy flow preserves rolling-upgrade compatibility.
        None => Ok(UploadSessionMode::LegacyRelay),
    }
}

fn validate_generation_intent_echo(
    response: &serde_json::Value,
    expected_generation: Option<&str>,
    create: bool,
) -> Result<bool> {
    match (response.get("expected_generation"), response.get("create")) {
        // Relays with upload-id sessions but predating the Page generation
        // protocol omit both fields. Their DTOs ignore the extra request
        // fields throughout upload/freeze, so this remains a valid rolling
        // upgrade path (without claiming generation protection).
        (None, None) => Ok(false),
        (Some(actual_generation), Some(actual_create)) => {
            let expected_generation = expected_generation
                .map_or(serde_json::Value::Null, |generation| {
                    serde_json::Value::String(generation.to_string())
                });
            if actual_generation == &expected_generation && actual_create.as_bool() == Some(create)
            {
                Ok(true)
            } else {
                Err(anyhow!(
                    "check-files returned a mismatched Page generation intent"
                ))
            }
        }
        // A partial echo is neither an old contract nor a trustworthy new one.
        _ => Err(anyhow!(
            "check-files returned an incomplete Page generation intent"
        )),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageInfo {
    pub slug: String,
    #[serde(default)]
    pub generation: String,
    pub visibility: String,
    pub title: String,
    pub file_count: i64,
    pub total_bytes: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub url_path: String,
    #[serde(default)]
    pub preview_url_path: Option<String>,
    #[serde(default)]
    pub deployed_version_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageVersionInfo {
    #[serde(default)]
    pub generation: String,
    pub version_id: String,
    pub title: String,
    pub file_count: i64,
    pub total_bytes: i64,
    pub has_worker: bool,
    pub note: String,
    pub created_at: i64,
    pub deployed: bool,
    pub preview_url_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageOpenLink {
    pub open_url: String,
    pub page_url: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Deserialize)]
struct PageOpenLinkRelayResponse {
    open_url_path: String,
    #[serde(default)]
    page_url_path: String,
    expires_in_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageSaveVersionResult {
    pub slug: String,
    pub generation: String,
    pub visibility: String,
    pub title: String,
    pub version_id: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub has_worker: bool,
    pub preview_url_path: String,
    pub deployed: bool,
}

/// Result of Agent/session publish: save version, optionally deploy to production.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageContentPublishResult {
    pub slug: String,
    pub generation: String,
    pub visibility: String,
    pub title: String,
    pub version_id: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub has_worker: bool,
    pub preview_url_path: String,
    pub deployed: bool,
    #[serde(default)]
    pub url_path: String,
    #[serde(default)]
    pub deployed_version_id: Option<String>,
    /// Absolute production URL (`{relay}{url_path}`), empty when not deployed.
    #[serde(default)]
    pub url: String,
    /// Absolute preview URL (`{relay}{preview_url_path}`).
    #[serde(default)]
    pub preview_url: String,
}

/// Backward-compatible alias used by older callers; now means save version only.
pub type PagePublishResult = PageSaveVersionResult;

/// Save a new immutable version from a local directory (does not deploy).
pub async fn save_page_version_to_relay(
    relay_url: &str,
    token: &str,
    web_dir: &str,
    slug: &str,
    visibility: &str,
    title: Option<&str>,
    note: Option<&str>,
) -> Result<PageSaveVersionResult> {
    let all_files = collect_page_files(Path::new(web_dir))?;
    save_page_version_from_collected_files(
        relay_url, token, slug, visibility, title, note, all_files, None,
    )
    .await
}

/// Save a new immutable version from inline path→UTF-8 content map (does not deploy).
pub async fn save_page_version_from_inline_files(
    relay_url: &str,
    token: &str,
    slug: &str,
    visibility: &str,
    title: Option<&str>,
    note: Option<&str>,
    files: &HashMap<String, String>,
) -> Result<PageSaveVersionResult> {
    let all_files = collect_inline_page_files(files)?;
    save_page_version_from_collected_files(
        relay_url, token, slug, visibility, title, note, all_files, None,
    )
    .await
}

/// Save (and optionally deploy) a page from either a local directory or inline files.
///
/// Exactly one of `directory` / `files` must be provided.
pub async fn publish_page_content_on_relay(
    relay_url: &str,
    token: &str,
    slug: &str,
    visibility: &str,
    title: Option<&str>,
    note: Option<&str>,
    deploy: bool,
    directory: Option<&str>,
    files: Option<&HashMap<String, String>>,
) -> Result<PageContentPublishResult> {
    let saved = match (directory, files) {
        (Some(dir), None) => {
            save_page_version_to_relay(relay_url, token, dir, slug, visibility, title, note).await?
        }
        (None, Some(map)) => {
            save_page_version_from_inline_files(
                relay_url, token, slug, visibility, title, note, map,
            )
            .await?
        }
        (Some(_), Some(_)) => {
            return Err(anyhow!("provide either directory or files, not both"));
        }
        (None, None) => {
            return Err(anyhow!("either directory or files is required"));
        }
    };

    finish_page_publication(relay_url, token, saved, deploy).await
}

/// Replace the content of the inspected Page without changing its access policy.
/// Keep the inspected generation throughout upload/freeze so a concurrent delete
/// and recreate cannot silently turn an update into creation or target a new Page.
pub async fn update_page_content_on_relay(
    relay_url: &str,
    token: &str,
    page: &PageInfo,
    title: Option<&str>,
    note: Option<&str>,
    deploy: bool,
    directory: Option<&str>,
    files: Option<&HashMap<String, String>>,
) -> Result<PageContentPublishResult> {
    let all_files = match (directory, files) {
        (Some(directory), None) => collect_page_files(Path::new(directory))?,
        (None, Some(files)) => collect_inline_page_files(files)?,
        _ => return Err(anyhow!("provide exactly one of directory or files")),
    };
    let saved = save_page_version_from_collected_files(
        relay_url,
        token,
        &page.slug,
        &page.visibility,
        title,
        note,
        all_files,
        Some(page),
    )
    .await?;
    finish_page_publication(relay_url, token, saved, deploy).await
}

async fn finish_page_publication(
    relay_url: &str,
    token: &str,
    saved: PageSaveVersionResult,
    deploy: bool,
) -> Result<PageContentPublishResult> {
    if !deploy {
        let preview_url = join_relay_url(relay_url, &saved.preview_url_path);
        return Ok(PageContentPublishResult {
            slug: saved.slug,
            generation: saved.generation,
            visibility: saved.visibility,
            title: saved.title,
            version_id: saved.version_id,
            file_count: saved.file_count,
            total_bytes: saved.total_bytes,
            has_worker: saved.has_worker,
            preview_url_path: saved.preview_url_path,
            deployed: false,
            url_path: String::new(),
            deployed_version_id: None,
            url: String::new(),
            preview_url,
        });
    }

    let info = deploy_page_version_on_relay(
        relay_url,
        token,
        &saved.slug,
        &saved.version_id,
        &saved.generation,
    )
    .await
    .map_err(|e| {
        anyhow!(
            "deploy failed: {e}. Version {} was saved on the relay but is not live; \
                 retry deploying version {} instead of re-publishing from scratch",
            saved.version_id,
            saved.version_id
        )
    })?;
    let preview_url = join_relay_url(relay_url, &saved.preview_url_path);
    let url = join_relay_url(relay_url, &info.url_path);
    Ok(PageContentPublishResult {
        slug: saved.slug,
        generation: info.generation,
        visibility: info.visibility,
        title: info.title,
        version_id: saved.version_id.clone(),
        file_count: saved.file_count,
        total_bytes: saved.total_bytes,
        has_worker: saved.has_worker,
        preview_url_path: saved.preview_url_path,
        deployed: true,
        url_path: info.url_path,
        deployed_version_id: info.deployed_version_id.or(Some(saved.version_id)),
        url,
        preview_url,
    })
}

/// Join account relay base URL with a page path into an absolute URL.
pub fn join_relay_url(relay_url: &str, path: &str) -> String {
    let path = path.trim();
    if path.is_empty() {
        return String::new();
    }
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    let base = relay_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return path.to_string();
    }
    if path.starts_with('/') {
        format!("{base}{path}")
    } else {
        format!("{base}/{path}")
    }
}

async fn save_page_version_from_collected_files(
    relay_url: &str,
    token: &str,
    slug: &str,
    visibility: &str,
    title: Option<&str>,
    note: Option<&str>,
    all_files: Vec<CollectedPageFile>,
    update_target: Option<&PageInfo>,
) -> Result<PageSaveVersionResult> {
    validate_slug(slug)?;
    validate_visibility(visibility)?;

    let total_bytes: u64 = all_files.iter().map(|f| f.content.len() as u64).sum();
    if total_bytes > MAX_PAGE_BYTES {
        return Err(anyhow!(
            "page exceeds size limit ({total_bytes} > {MAX_PAGE_BYTES} bytes)"
        ));
    }

    let expected_title = update_target
        .filter(|_| title.is_none())
        .map(|page| page.title.as_str());
    let title = title
        .or(expected_title)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(slug)
        .to_string();

    info!(
        "Collected {} page files ({} bytes) for slug {slug}",
        all_files.len(),
        total_bytes
    );

    let client = relay_http_client();
    let relay_base = relay_url.trim_end_matches('/');
    let auth = format!("Bearer {token}");

    let manifest: Vec<PageUploadManifestEntry> = all_files
        .iter()
        .map(|f| PageUploadManifestEntry {
            path: f.rel_path.clone(),
            hash: f.hash.clone(),
            size: f.content.len() as u64,
        })
        .collect();
    let upload_id = uuid::Uuid::new_v4().simple().to_string();
    let existing_page = match update_target {
        Some(page) => Some(page.clone()),
        None => list_pages_from_relay(relay_url, token)
            .await?
            .into_iter()
            .find(|page| page.slug == slug),
    };
    let create = existing_page.is_none();
    let expected_generation = existing_page
        .as_ref()
        .map(|page| page.generation.as_str())
        .filter(|generation| !generation.is_empty())
        .map(str::to_string);

    let check_url = format!("{relay_base}/api/pages/check-files");
    let check_resp = send_with_retry(
        "check page files",
        client
            .post(&check_url)
            .header("Authorization", &auth)
            .json(&serde_json::json!({
                "slug": slug,
                "upload_id": upload_id,
                "expected_generation": expected_generation,
                "create": create,
                "files": manifest,
            }))
            .timeout(std::time::Duration::from_secs(30)),
        RelayHttpRetry::IdempotentWrite,
    )
    .await
    .map_err(|e| anyhow!("check-files request failed: {e}"))?;
    if !check_resp.status().is_success() {
        let status = check_resp.status();
        let body = check_resp.text().await.unwrap_or_default();
        return Err(anyhow!("check-files failed: HTTP {status} — {body}"));
    }
    let check_body: serde_json::Value = check_resp
        .json()
        .await
        .map_err(|e| anyhow!("parse check-files response: {e}"))?;
    let freeze_idempotency_supported = check_body["freeze_idempotency_supported"]
        .as_bool()
        .unwrap_or(false);
    let upload_mode = validate_upload_session_echo(&check_body, &upload_id)?;
    let generation_bound = upload_mode == UploadSessionMode::ManifestBound
        && validate_generation_intent_echo(&check_body, expected_generation.as_deref(), create)?;
    if update_target.is_some()
        && (upload_mode != UploadSessionMode::ManifestBound
            || !generation_bound
            || expected_generation.is_none()
            || check_body["metadata_preconditions_supported"].as_bool() != Some(true))
    {
        return Err(anyhow!(
            "This Relay does not support safe Page content updates; upgrade the Relay before retrying. Do not substitute publish because it can change access settings."
        ));
    }
    if upload_mode == UploadSessionMode::LegacyRelay {
        warn!(
            "Page relay does not support manifest-bound upload sessions; using the legacy upload flow"
        );
    } else if !generation_bound {
        warn!(
            "Page relay does not support generation-bound uploads; using its legacy generation flow"
        );
    }
    let needed: Vec<String> = check_body["needed"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if !needed.is_empty() {
        upload_needed_page_files(
            &client,
            relay_base,
            &auth,
            slug,
            &upload_id,
            expected_generation.as_deref(),
            create,
            &title,
            visibility,
            &all_files,
            &needed,
        )
        .await?;
    } else {
        // Touch draft metadata with empty finalize batch.
        post_upload_batch(
            &client,
            &format!("{relay_base}/api/pages/upload-files"),
            &auth,
            slug,
            &upload_id,
            expected_generation.as_deref(),
            create,
            &title,
            visibility,
            &HashMap::new(),
            0,
            true,
        )
        .await?;
    }

    let freeze_url = format!("{relay_base}/api/pages/{slug}/versions");
    let freeze_request = client
        .post(&freeze_url)
        .header("Authorization", &auth)
        .json(&serde_json::json!({
            "upload_id": upload_id,
            "expected_generation": expected_generation,
            "create": create,
            "title": title,
            "note": note.unwrap_or(""),
            "expected_visibility": update_target.map(|page| &page.visibility),
            "expected_title": expected_title,
        }))
        .timeout(std::time::Duration::from_secs(30));
    let freeze_policy = if freeze_idempotency_supported {
        RelayHttpRetry::IdempotentWrite
    } else {
        RelayHttpRetry::SingleAttempt
    };
    let freeze_resp = send_with_retry("freeze page version", freeze_request, freeze_policy)
        .await
        .map_err(|e| anyhow!("freeze version failed: {e}"))?;
    if !freeze_resp.status().is_success() {
        let status = freeze_resp.status();
        if update_target.is_some() && status == reqwest::StatusCode::CONFLICT {
            return Err(anyhow!(
                "Page changed while saving content; list the Page again and retry with its current title and permissions"
            ));
        }
        let body = freeze_resp.text().await.unwrap_or_default();
        return Err(anyhow!("freeze version failed: HTTP {status} — {body}"));
    }
    let version: PageVersionInfo = freeze_resp
        .json()
        .await
        .map_err(|e| anyhow!("parse freeze response: {e}"))?;

    Ok(PageSaveVersionResult {
        slug: slug.to_string(),
        generation: version.generation,
        visibility: visibility.to_string(),
        title,
        version_id: version.version_id,
        file_count: all_files.len() as u64,
        total_bytes,
        has_worker: version.has_worker,
        preview_url_path: version.preview_url_path,
        deployed: false,
    })
}

/// Legacy name: save version only (does not deploy).
pub async fn publish_page_to_relay(
    relay_url: &str,
    token: &str,
    web_dir: &str,
    slug: &str,
    visibility: &str,
    title: Option<&str>,
) -> Result<PagePublishResult> {
    save_page_version_to_relay(relay_url, token, web_dir, slug, visibility, title, None).await
}

pub async fn list_pages_from_relay(relay_url: &str, token: &str) -> Result<Vec<PageInfo>> {
    let client = relay_http_client();
    let url = format!("{}/api/pages", relay_url.trim_end_matches('/'));
    let resp = send_with_retry(
        "list pages",
        client
            .get(&url)
            .header("Authorization", format!("Bearer {token}"))
            .timeout(std::time::Duration::from_secs(15)),
        RelayHttpRetry::SafeRead,
    )
    .await
    .map_err(|e| anyhow!("list pages failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("list pages failed: HTTP {status} — {body}"));
    }
    resp.json()
        .await
        .map_err(|e| anyhow!("parse list pages: {e}"))
}

pub async fn list_page_versions_from_relay(
    relay_url: &str,
    token: &str,
    slug: &str,
    expected_generation: &str,
) -> Result<Vec<PageVersionInfo>> {
    validate_slug(slug)?;
    let client = relay_http_client();
    let url = format!(
        "{}/api/pages/{}/versions?expected_generation={}",
        relay_url.trim_end_matches('/'),
        slug,
        expected_generation
    );
    let resp = send_with_retry(
        "list page versions",
        client
            .get(&url)
            .header("Authorization", format!("Bearer {token}"))
            .timeout(std::time::Duration::from_secs(15)),
        RelayHttpRetry::SafeRead,
    )
    .await
    .map_err(|e| anyhow!("list versions failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("list versions failed: HTTP {status} — {body}"));
    }
    resp.json()
        .await
        .map_err(|e| anyhow!("parse list versions: {e}"))
}

/// Resolve browser and canonical URLs for a production Page or immutable
/// preview. Page access authentication is performed by the Relay at the Page
/// URL; the management bearer token is never embedded in either returned URL.
pub async fn create_page_open_link_on_relay(
    relay_url: &str,
    token: &str,
    slug: &str,
    version_id: Option<&str>,
    expected_generation: &str,
) -> Result<PageOpenLink> {
    validate_slug(slug)?;
    let client = relay_http_client();
    let url = format!("{}/api/pages/{}", relay_url.trim_end_matches('/'), slug);
    let resp = send_with_retry(
        "create page open link",
        client
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .json(&serde_json::json!({
                "version_id": version_id,
                "expected_generation": expected_generation,
            }))
            .timeout(std::time::Duration::from_secs(15)),
        RelayHttpRetry::SafeRead,
    )
    .await
    .map_err(|e| anyhow!("create page open link failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "create page open link failed: HTTP {status} — {body}"
        ));
    }
    let result: PageOpenLinkRelayResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("parse page open link response: {e}"))?;
    let page_url_path = if result.page_url_path.is_empty() {
        &result.open_url_path
    } else {
        &result.page_url_path
    };
    Ok(PageOpenLink {
        open_url: join_relay_url(relay_url, &result.open_url_path),
        page_url: join_relay_url(relay_url, page_url_path),
        expires_in_seconds: result.expires_in_seconds,
    })
}

pub async fn deploy_page_version_on_relay(
    relay_url: &str,
    token: &str,
    slug: &str,
    version_id: &str,
    expected_generation: &str,
) -> Result<PageInfo> {
    validate_slug(slug)?;
    let client = relay_http_client();
    let url = format!(
        "{}/api/pages/{}/deploy",
        relay_url.trim_end_matches('/'),
        slug
    );
    let resp = send_with_retry(
        "deploy page version",
        client
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .json(&serde_json::json!({
                "version_id": version_id,
                "expected_generation": expected_generation,
            }))
            .timeout(std::time::Duration::from_secs(15)),
        RelayHttpRetry::IdempotentWrite,
    )
    .await
    .map_err(|e| anyhow!("deploy failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("deploy failed: HTTP {status} — {body}"));
    }
    resp.json().await.map_err(|e| anyhow!("parse deploy: {e}"))
}

pub async fn delete_page_version_on_relay(
    relay_url: &str,
    token: &str,
    slug: &str,
    version_id: &str,
    expected_generation: &str,
) -> Result<()> {
    validate_slug(slug)?;
    let client = relay_http_client();
    let url = format!(
        "{}/api/pages/{}/versions/{}?expected_generation={}",
        relay_url.trim_end_matches('/'),
        slug,
        version_id,
        expected_generation
    );
    let resp = client
        .delete(&url)
        .header("Authorization", format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| anyhow!("delete version failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("delete version failed: HTTP {status} — {body}"));
    }
    Ok(())
}

pub async fn update_page_on_relay(
    relay_url: &str,
    token: &str,
    slug: &str,
    expected_generation: &str,
    visibility: Option<&str>,
    title: Option<&str>,
) -> Result<PageInfo> {
    validate_slug(slug)?;
    if let Some(v) = visibility {
        validate_visibility(v)?;
    }
    let client = relay_http_client();
    let url = format!("{}/api/pages/{}", relay_url.trim_end_matches('/'), slug);
    let mut body = serde_json::Map::new();
    body.insert(
        "expected_generation".into(),
        serde_json::json!(expected_generation),
    );
    if let Some(v) = visibility {
        body.insert("visibility".into(), serde_json::json!(v));
    }
    if let Some(t) = title {
        body.insert("title".into(), serde_json::json!(t));
    }
    let resp = send_with_retry(
        "update page",
        client
            .patch(&url)
            .header("Authorization", format!("Bearer {token}"))
            .json(&body)
            .timeout(std::time::Duration::from_secs(15)),
        RelayHttpRetry::IdempotentWrite,
    )
    .await
    .map_err(|e| anyhow!("update page failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("update page failed: HTTP {status} — {body}"));
    }
    resp.json()
        .await
        .map_err(|e| anyhow!("parse update page: {e}"))
}

pub async fn unpublish_page_from_relay(
    relay_url: &str,
    token: &str,
    slug: &str,
    expected_generation: &str,
) -> Result<()> {
    validate_slug(slug)?;
    let client = relay_http_client();
    let url = format!(
        "{}/api/pages/{}/unpublish?expected_generation={}",
        relay_url.trim_end_matches('/'),
        slug,
        expected_generation
    );
    let resp = send_with_retry(
        "unpublish page",
        client
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .timeout(std::time::Duration::from_secs(15)),
        RelayHttpRetry::IdempotentWrite,
    )
    .await
    .map_err(|e| anyhow!("unpublish page failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("unpublish page failed: HTTP {status} — {body}"));
    }
    Ok(())
}

pub async fn delete_page_from_relay(
    relay_url: &str,
    token: &str,
    slug: &str,
    expected_generation: &str,
) -> Result<()> {
    validate_slug(slug)?;
    let client = relay_http_client();
    let url = format!(
        "{}/api/pages/{}?expected_generation={}",
        relay_url.trim_end_matches('/'),
        slug,
        expected_generation
    );
    let resp = client
        .delete(&url)
        .header("Authorization", format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| anyhow!("delete page failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("delete page failed: HTTP {status} — {body}"));
    }
    Ok(())
}

fn validate_slug(slug: &str) -> Result<()> {
    let bytes = slug.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return Err(anyhow!("invalid slug: must be 1-64 characters"));
    }
    let Some(first) = bytes.first() else {
        return Err(anyhow!("invalid slug"));
    };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return Err(anyhow!(
            "invalid slug: must start with a lowercase letter or digit"
        ));
    }
    if !bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
    {
        return Err(anyhow!(
            "invalid slug: only lowercase letters, digits, and hyphens allowed"
        ));
    }
    Ok(())
}

fn validate_visibility(v: &str) -> Result<()> {
    match v {
        "private" | "relay" | "public" => Ok(()),
        _ => Err(anyhow!(
            "invalid visibility: expected private, relay, or public"
        )),
    }
}

fn collect_page_files(base: &Path) -> Result<Vec<CollectedPageFile>> {
    let base_metadata = std::fs::symlink_metadata(base)
        .map_err(|_| anyhow!("page directory does not exist: {}", base.display()))?;
    if base_metadata.file_type().is_symlink() || !base_metadata.is_dir() {
        return Err(anyhow!("page directory does not exist: {}", base.display()));
    }
    let has_index = is_regular_page_source_file(&base.join("index.html"))?;
    let has_worker = is_regular_page_source_file(&base.join("server").join("worker.js"))?;
    if !has_index && !has_worker {
        return Err(anyhow!(
            "page directory must contain index.html and/or server/worker.js: {}",
            base.display()
        ));
    }
    let canonical_base = std::fs::canonicalize(base)?;
    let mut all_files = Vec::new();
    collect_files_with_hash(&canonical_base, &canonical_base, &mut all_files)?;
    Ok(all_files)
}

fn collect_inline_page_files(files: &HashMap<String, String>) -> Result<Vec<CollectedPageFile>> {
    use sha2::{Digest, Sha256};

    if files.is_empty() {
        return Err(anyhow!("files map must not be empty"));
    }
    if files.len() > MAX_PAGE_FILES {
        return Err(anyhow!(
            "page exceeds file count limit ({} > {MAX_PAGE_FILES})",
            files.len()
        ));
    }

    let has_index = files.contains_key("index.html");
    let has_worker = files.contains_key("server/worker.js");
    if !has_index && !has_worker {
        return Err(anyhow!(
            "files must include index.html and/or server/worker.js"
        ));
    }

    let mut all_files = Vec::with_capacity(files.len());
    for (raw_path, content) in files {
        let rel = raw_path.replace('\\', "/");
        let rel = rel.trim_start_matches('/');
        if rel.is_empty() || rel.contains("..") || rel.starts_with('/') {
            return Err(anyhow!("invalid file path: {raw_path}"));
        }
        if Path::new(rel).is_absolute() {
            return Err(anyhow!("absolute file paths are not allowed: {raw_path}"));
        }
        let bytes = content.as_bytes();
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(anyhow!(
                "file exceeds size limit: {rel} ({} > {MAX_FILE_BYTES} bytes)",
                bytes.len()
            ));
        }
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let hash = format!("{:x}", hasher.finalize());
        all_files.push(CollectedPageFile {
            rel_path: rel.to_string(),
            content: bytes.to_vec(),
            hash,
        });
    }
    Ok(all_files)
}

fn collect_files_with_hash(
    base: &Path,
    dir: &Path,
    out: &mut Vec<CollectedPageFile>,
) -> Result<()> {
    use sha2::{Digest, Sha256};
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(anyhow!(
                "symbolic links are not allowed in Page sources: {}",
                path.display()
            ));
        }
        let canonical_path = std::fs::canonicalize(&path)?;
        if !canonical_path.starts_with(base) {
            return Err(anyhow!(
                "Page source entry resolves outside its directory: {}",
                path.display()
            ));
        }
        if file_type.is_dir() {
            collect_files_with_hash(base, &canonical_path, out)?;
        } else if file_type.is_file() {
            if out.len() >= MAX_PAGE_FILES {
                return Err(anyhow!("page exceeds file count limit ({MAX_PAGE_FILES})"));
            }
            let rel = canonical_path
                .strip_prefix(base)
                .unwrap_or(&canonical_path)
                .to_string_lossy()
                .replace('\\', "/");
            if rel.contains("..") {
                continue;
            }
            let content = std::fs::read(&canonical_path)?;
            if content.len() as u64 > MAX_FILE_BYTES {
                return Err(anyhow!(
                    "file exceeds size limit: {rel} ({} > {MAX_FILE_BYTES} bytes)",
                    content.len()
                ));
            }
            let mut hasher = Sha256::new();
            hasher.update(&content);
            let hash = format!("{:x}", hasher.finalize());
            out.push(CollectedPageFile {
                rel_path: rel,
                content,
                hash,
            });
        } else {
            return Err(anyhow!(
                "unsupported Page source entry type: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn is_regular_page_source_file(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(anyhow!(
            "symbolic links are not allowed in Page sources: {}",
            path.display()
        )),
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn upload_needed_page_files(
    client: &reqwest::Client,
    relay_base: &str,
    auth: &str,
    slug: &str,
    upload_id: &str,
    expected_generation: Option<&str>,
    create: bool,
    title: &str,
    visibility: &str,
    all_files: &[CollectedPageFile],
    needed: &[String],
) -> Result<()> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    let needed_set: HashSet<&str> = needed.iter().map(String::as_str).collect();
    let mut files_payload: Vec<(String, serde_json::Value, usize)> = Vec::new();
    for file in all_files {
        if needed_set.contains(file.rel_path.as_str()) {
            let encoded = B64.encode(&file.content);
            let encoded_len = encoded.len();
            files_payload.push((
                file.rel_path.clone(),
                serde_json::json!({ "content": encoded, "hash": file.hash }),
                encoded_len,
            ));
        }
    }
    let url = format!("{relay_base}/api/pages/upload-files");
    let mut current_batch: HashMap<String, serde_json::Value> = HashMap::new();
    let mut current_batch_b64_bytes = 0usize;
    let mut batch_index = 0usize;

    for (path, entry, entry_len) in files_payload {
        let should_flush = !current_batch.is_empty()
            && current_batch_b64_bytes + entry_len > MAX_UPLOAD_BATCH_BASE64_BYTES;
        if should_flush {
            post_upload_batch(
                client,
                &url,
                auth,
                slug,
                upload_id,
                expected_generation,
                create,
                title,
                visibility,
                &current_batch,
                batch_index,
                false,
            )
            .await?;
            batch_index += 1;
            current_batch = HashMap::new();
            current_batch_b64_bytes = 0;
        }
        current_batch.insert(path, entry);
        current_batch_b64_bytes += entry_len;
    }
    if !current_batch.is_empty() {
        post_upload_batch(
            client,
            &url,
            auth,
            slug,
            upload_id,
            expected_generation,
            create,
            title,
            visibility,
            &current_batch,
            batch_index,
            true,
        )
        .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn post_upload_batch(
    client: &reqwest::Client,
    url: &str,
    auth: &str,
    slug: &str,
    upload_id: &str,
    expected_generation: Option<&str>,
    create: bool,
    title: &str,
    visibility: &str,
    files: &HashMap<String, serde_json::Value>,
    batch_index: usize,
    finalize: bool,
) -> Result<()> {
    let resp = send_with_retry(
        "upload page files",
        client
            .post(url)
            .header("Authorization", auth)
            .json(&serde_json::json!({
                "slug": slug,
                "upload_id": upload_id,
                "expected_generation": expected_generation,
                "create": create,
                "title": title,
                "visibility": visibility,
                "files": files,
                "finalize": finalize,
            }))
            .timeout(std::time::Duration::from_secs(60)),
        RelayHttpRetry::IdempotentWrite,
    )
    .await
    .map_err(|e| anyhow!("upload-files batch {batch_index}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "upload-files batch {batch_index} failed: HTTP {status} — {body}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_rules() {
        assert!(validate_slug("my-site").is_ok());
        assert!(validate_slug("Bad").is_err());
    }

    #[test]
    fn join_relay_url_builds_absolute_links() {
        assert_eq!(
            join_relay_url("https://watchitrun.com/", "/p/user/site"),
            "https://watchitrun.com/p/user/site"
        );
        assert_eq!(
            join_relay_url("https://watchitrun.com", "p/user/site"),
            "https://watchitrun.com/p/user/site"
        );
        assert_eq!(
            join_relay_url("https://x.test", "https://already.example/p"),
            "https://already.example/p"
        );
    }

    #[test]
    fn upload_session_echo_accepts_legacy_relay_but_rejects_mismatch() {
        let legacy = serde_json::json!({ "needed": ["index.html"] });
        assert_eq!(
            validate_upload_session_echo(&legacy, "abc").unwrap(),
            UploadSessionMode::LegacyRelay
        );

        let current = serde_json::json!({ "upload_id": "abc", "needed": [] });
        assert_eq!(
            validate_upload_session_echo(&current, "abc").unwrap(),
            UploadSessionMode::ManifestBound
        );

        let mismatch = serde_json::json!({ "upload_id": "other", "needed": [] });
        assert!(validate_upload_session_echo(&mismatch, "abc").is_err());
    }

    #[test]
    fn generation_intent_echo_accepts_old_relay_only_when_both_fields_are_absent() {
        let old_relay = serde_json::json!({ "upload_id": "abc", "needed": [] });
        assert!(!validate_generation_intent_echo(&old_relay, Some("generation-a"), false).unwrap());

        let current = serde_json::json!({
            "upload_id": "abc",
            "expected_generation": "generation-a",
            "create": false,
            "needed": [],
        });
        assert!(validate_generation_intent_echo(&current, Some("generation-a"), false).unwrap());

        let create = serde_json::json!({
            "upload_id": "abc",
            "expected_generation": null,
            "create": true,
            "needed": [],
        });
        assert!(validate_generation_intent_echo(&create, None, true).unwrap());

        let partial = serde_json::json!({
            "upload_id": "abc",
            "expected_generation": "generation-a",
            "needed": [],
        });
        assert!(validate_generation_intent_echo(&partial, Some("generation-a"), false).is_err());

        let mismatch = serde_json::json!({
            "upload_id": "abc",
            "expected_generation": "generation-b",
            "create": false,
            "needed": [],
        });
        assert!(validate_generation_intent_echo(&mismatch, Some("generation-a"), false).is_err());
    }

    #[test]
    fn collect_allows_worker_without_index() {
        let base = std::env::temp_dir().join(format!(
            "openbitfun-page-worker-only-{}",
            uuid::Uuid::new_v4()
        ));
        let server = base.join("server");
        std::fs::create_dir_all(&server).unwrap();
        std::fs::write(
            server.join("worker.js"),
            b"function fetch(){return {status:200,body:'ok'};}",
        )
        .unwrap();
        let files = collect_page_files(&base).unwrap();
        assert!(files.iter().any(|f| f.rel_path == "server/worker.js"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn inline_files_require_entry_and_reject_traversal() {
        let mut ok = HashMap::new();
        ok.insert("index.html".into(), "<html>hi</html>".into());
        let files = collect_inline_page_files(&ok).unwrap();
        assert_eq!(files.len(), 1);

        let mut bad = HashMap::new();
        bad.insert("../secret".into(), "x".into());
        assert!(collect_inline_page_files(&bad).is_err());

        let mut empty_entry = HashMap::new();
        empty_entry.insert("styles.css".into(), "body{}".into());
        assert!(collect_inline_page_files(&empty_entry).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn directory_source_rejects_symlinks_to_external_files() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "openbitfun-page-symlink-external-{}",
            uuid::Uuid::new_v4()
        ));
        let page = root.join("page");
        std::fs::create_dir_all(&page).unwrap();
        std::fs::write(page.join("index.html"), b"<html></html>").unwrap();
        std::fs::write(root.join("secret.txt"), b"secret").unwrap();
        symlink(root.join("secret.txt"), page.join("secret.txt")).unwrap();

        let error = collect_page_files(&page).expect_err("external symlink must be rejected");
        assert!(error.to_string().contains("symbolic links are not allowed"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn directory_source_rejects_symlink_loops() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "openbitfun-page-symlink-loop-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.html"), b"<html></html>").unwrap();
        symlink(&root, root.join("loop")).unwrap();

        let error = collect_page_files(&root).expect_err("symlink loop must be rejected");
        assert!(error.to_string().contains("symbolic links are not allowed"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn publish_source_xor_is_enforced() {
        let err = publish_page_content_on_relay(
            "http://127.0.0.1:9",
            "tok",
            "demo",
            "public",
            None,
            None,
            false,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("directory or files"));
    }
}
