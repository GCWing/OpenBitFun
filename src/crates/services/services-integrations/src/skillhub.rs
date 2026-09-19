//! SkillHub's ClawHub-compatible discovery and ZIP download protocol.
//! No npm subprocess or controller-side filesystem is involved.

use reqwest::Url;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::path::Path;
use std::time::Duration;

const MAX_PACKAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 50 * 1024 * 1024;
const MAX_FILES: usize = 1000;
pub const ORIGIN_FILE: &str = ".openbitfun-skillhub.json";

pub struct SkillHubClient {
    base: Url,
    client: reqwest::Client,
    token: String,
}

#[derive(Debug, Deserialize)]
pub struct SearchResponse {
    pub results: Vec<SearchItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    pub slug: String,
    #[serde(alias = "name")]
    pub display_name: String,
    #[serde(default, alias = "description")]
    pub summary: Option<String>,
}

/// A validated archive. Its paths cannot be supplied independently to the installer.
pub struct SkillPackage {
    files: BTreeMap<String, PackageFile>,
}

struct PackageFile {
    bytes: Vec<u8>,
    #[cfg(unix)]
    unix_mode: Option<u32>,
}

impl SkillPackage {
    pub fn markdown(&self) -> Result<&str, String> {
        std::str::from_utf8(&self.files["SKILL.md"].bytes)
            .map_err(|_| "SKILL.md must contain UTF-8 text".into())
    }
}

impl SkillHubClient {
    /// Accept the deployment root, including an optional reverse-proxy subpath.
    pub fn new(base: &str, token: &str) -> Result<Self, String> {
        let mut base = Url::parse(base.trim()).map_err(|_| "Invalid SkillHub URL")?;
        if !matches!(base.scheme(), "https" | "http")
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err("SkillHub URL must be an HTTP(S) deployment root without credentials, query or fragment".into());
        }
        base.set_path(&format!("{}/", base.path().trim_end_matches('/')));
        let client = crate::reqwest_client_builder()
            .timeout(Duration::from_secs(60))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "Failed to initialize SkillHub client")?;
        Ok(Self {
            base,
            client,
            token: token.trim().into(),
        })
    }

    pub fn installation_id(&self, slug: &str) -> Result<String, String> {
        validate_slug(slug)?;
        Ok(format!(
            "skillhub:{}#{}",
            self.base.as_str().trim_end_matches('/'),
            slug
        ))
    }

    pub fn slug_from_installation_id<'a>(&self, id: &'a str) -> Result<&'a str, String> {
        let prefix = format!("skillhub:{}#", self.base.as_str().trim_end_matches('/'));
        let slug = id.strip_prefix(&prefix).ok_or(
            "Skill belongs to a different marketplace. Refresh marketplace results and retry.",
        )?;
        validate_slug(slug)?;
        Ok(slug)
    }

    pub fn detail_url(&self, slug: &str) -> Result<String, String> {
        validate_slug(slug)?;
        // SkillHub's web route uses a namespace and skill slug, not the canonical coordinate.
        let (namespace, name) = slug.split_once("--").unwrap_or(("global", slug));
        let mut url = self
            .base
            .join("space/")
            .map_err(|_| "Invalid SkillHub URL")?;
        url.path_segments_mut()
            .map_err(|_| "Invalid SkillHub URL")?
            .pop_if_empty()
            .push(namespace)
            .push(name);
        Ok(url.into())
    }

    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<reqwest::Response, String> {
        let url = self.base.join(path).map_err(|_| "Invalid SkillHub URL")?;
        let mut request = self.client.get(url).query(query);
        if !self.token.is_empty() {
            request = request.bearer_auth(&self.token);
        }
        let response = request
            .send()
            .await
            .map_err(|_| "Could not reach SkillHub. Check the URL and network connection.")?;
        match response.status().as_u16() {
            401 => Err("SkillHub authentication failed. Check the API token.".into()),
            403 => Err("You do not have permission to access this SkillHub resource.".into()),
            code if !(200..300).contains(&code) => {
                Err(format!("SkillHub request failed with status {code}"))
            }
            _ => Ok(response),
        }
    }

    pub async fn search(&self, query: &str, limit: u32) -> Result<Vec<SearchItem>, String> {
        let response = self
            .get(
                "api/v1/search",
                &[
                    ("q", query.into()),
                    ("limit", limit.to_string()),
                    ("page", "0".into()),
                ],
            )
            .await?;
        let payload: SearchResponse = response
            .json()
            .await
            .map_err(|_| "Invalid SkillHub search response")?;
        for item in &payload.results {
            validate_slug(&item.slug)?;
        }
        Ok(payload.results)
    }

    pub async fn download(&self, slug: &str) -> Result<Vec<u8>, String> {
        validate_slug(slug)?;
        // Use the native download route: canonical namespaces remain unambiguous, and
        // the compat redirect's root-relative Location cannot lose a deployment subpath.
        let (namespace, name) = slug.split_once("--").unwrap_or(("global", slug));
        let mut url = self
            .base
            .join("api/v1/skills/")
            .map_err(|_| "Invalid SkillHub URL")?;
        url.path_segments_mut()
            .map_err(|_| "Invalid SkillHub URL")?
            .pop_if_empty()
            .push(namespace)
            .push(name)
            .push("download");
        let mut response = self.get(url.as_str(), &[]).await?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_PACKAGE_BYTES as u64)
        {
            return Err("SkillHub package exceeds 20 MiB".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Failed to download SkillHub package")?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_PACKAGE_BYTES {
                return Err("SkillHub package exceeds 20 MiB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

fn portable_path_component(name: &str) -> bool {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name.contains(['\\', ':', '<', '>', '\"', '|', '?', '*'])
        || name.chars().any(char::is_control)
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn validate_slug(slug: &str) -> Result<(), String> {
    if !portable_path_component(slug)
        || slug == "."
        || slug == ".."
        || slug.contains(['/', '\\', ':', '#', '?', '@'])
        || slug.chars().any(char::is_control)
    {
        return Err("Invalid SkillHub skill coordinate".into());
    }
    Ok(())
}

/// Validate before writing any files. Reject traversal, links, duplicate paths and ZIP bombs.
pub fn unpack_package(bytes: &[u8]) -> Result<SkillPackage, String> {
    if bytes.len() > MAX_PACKAGE_BYTES {
        return Err("SkillHub package exceeds 20 MiB".into());
    }
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "Invalid SkillHub ZIP package")?;
    if archive.len() > MAX_FILES {
        return Err("SkillHub package contains too many files".into());
    }
    let mut files = BTreeMap::new();
    let mut total = 0u64;
    let mut seen_paths = std::collections::HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "Invalid SkillHub ZIP entry")?;
        let name = entry.name().to_string();
        if entry.enclosed_name().is_none()
            || name.starts_with('/')
            || name.contains(['\\', ':'])
            || name
                .trim_end_matches('/')
                .split('/')
                .any(|part| !portable_path_component(part))
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Unsafe path in SkillHub package".into());
        }
        if entry.is_dir() {
            continue;
        }
        if name.eq_ignore_ascii_case(ORIGIN_FILE) {
            return Err("SkillHub package contains reserved installation metadata".into());
        }
        total = total
            .checked_add(entry.size())
            .ok_or("SkillHub package size overflow")?;
        if total > MAX_EXTRACTED_BYTES {
            return Err("SkillHub extracted package exceeds 50 MiB".into());
        }
        let mut content = Vec::new();
        entry
            .by_ref()
            .take(MAX_EXTRACTED_BYTES + 1)
            .read_to_end(&mut content)
            .map_err(|_| "Failed to read SkillHub ZIP entry")?;
        if content.len() as u64 > entry.size() {
            return Err("Invalid SkillHub ZIP entry size".into());
        }
        if !seen_paths.insert(name.to_lowercase()) {
            return Err("Duplicate path in SkillHub package".into());
        }
        files.insert(
            name,
            PackageFile {
                bytes: content,
                #[cfg(unix)]
                unix_mode: entry.unix_mode(),
            },
        );
    }
    if files
        .get("SKILL.md")
        .is_some_and(|file| file.bytes.len() > 1024 * 1024)
    {
        return Err("SKILL.md exceeds the 1 MiB discovery limit".into());
    }
    if !files.contains_key("SKILL.md") {
        return Err("SkillHub package must contain SKILL.md at its root".into());
    }
    Ok(SkillPackage { files })
}

/// Stage outside the scanned Skills root. Never replace an existing installation.
pub fn install_package(
    root: &Path,
    slug: &str,
    files: &SkillPackage,
    origin: &str,
) -> Result<(), String> {
    validate_slug(slug)?;
    std::fs::create_dir_all(root).map_err(|e| format!("Failed to create Skills directory: {e}"))?;
    let target = root.join(slug);
    if target.symlink_metadata().is_ok() {
        return Err("Skill already exists in the selected directory".into());
    }
    let stage = tempfile::Builder::new()
        .prefix(".skillhub-")
        .tempdir_in(root.parent().ok_or("Skills directory must have a parent")?)
        .map_err(|e| format!("Failed to stage Skill: {e}"))?;
    for (name, file) in &files.files {
        let path = stage.path().join(name);
        std::fs::create_dir_all(path.parent().ok_or("Invalid Skill path")?)
            .map_err(|e| format!("Failed to stage Skill: {e}"))?;
        std::fs::write(&path, &file.bytes).map_err(|e| format!("Failed to stage Skill: {e}"))?;
    }
    #[cfg(unix)]
    for (name, file) in &files.files {
        use std::os::unix::fs::PermissionsExt;
        if let Some(mode) = file.unix_mode {
            std::fs::set_permissions(
                stage.path().join(name),
                std::fs::Permissions::from_mode((mode & 0o777) | 0o400),
            )
            .map_err(|e| format!("Failed to set Skill file permissions: {e}"))?;
        }
    }
    let marker = serde_json::json!({ "version": 1, "installationSource": origin });
    std::fs::write(stage.path().join(ORIGIN_FILE), marker.to_string())
        .map_err(|e| format!("Failed to write Skill origin: {e}"))?;
    std::fs::rename(stage.path(), &target).map_err(|e| format!("Failed to install Skill: {e}"))?;
    Ok(())
}

/// Used only for local paths on the serving host, never for remote workspace paths.
pub async fn read_installation_source(path: &Path) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path.join(ORIGIN_FILE)).await.ok()?;
    let mut bytes = Vec::new();
    file.take(8193).read_to_end(&mut bytes).await.ok()?;
    if bytes.len() > 8192 {
        return None;
    }
    let marker: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if marker.get("version")?.as_u64()? != 1 {
        return None;
    }
    let source = marker.get("installationSource")?.as_str()?;
    source.starts_with("skillhub:").then(|| source.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn package(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    async fn server(
        responses: Vec<(u16, Vec<(&'static str, String)>, Vec<u8>)>,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        tokio::spawn(async move {
            for (status, headers, body) in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0; 1024];
                    let count = stream.read(&mut buffer).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                captured
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(bytes).unwrap());
                let mut response = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                for (name, value) in headers {
                    response.push_str(&format!("{name}: {value}\r\n"));
                }
                response.push_str("\r\n");
                stream.write_all(response.as_bytes()).await.unwrap();
                stream.write_all(&body).await.unwrap();
            }
        });
        (format!("http://{address}/hub"), requests)
    }

    #[tokio::test]
    async fn search_matches_skillhub_controller_dto_and_preserves_subpath() {
        let body = br#"{"results":[{"slug":"team--review","displayName":"Code Review","summary":"Internal rules","version":"1.2.0","score":1,"updatedAt":0}]}"#;
        let (url, requests) = server(vec![(
            200,
            vec![("Content-Type", "application/json".into())],
            body.to_vec(),
        )])
        .await;
        let client = SkillHubClient::new(&url, "test-token").unwrap();
        let items = client.search("", 20).await.unwrap();
        assert_eq!(items[0].display_name, "Code Review");
        assert_eq!(items[0].summary.as_deref(), Some("Internal rules"));
        assert_eq!(
            client.detail_url(&items[0].slug).unwrap(),
            format!("{url}/space/team/review")
        );
        let request = &requests.lock().unwrap()[0];
        assert!(request.starts_with("GET /hub/api/v1/search?q=&limit=20&page=0 "));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer test-token"));
    }

    #[tokio::test]
    async fn authenticated_download_follows_skillhub_redirect_and_installs_supporting_files() {
        let bytes = package(&[
            (
                "SKILL.md",
                b"---\nname: review\ndescription: Internal review\n---\nReview",
            ),
            ("references/rules.md", b"Rules"),
        ]);
        let (url, requests) = server(vec![
            (
                302,
                vec![("Location", "/hub/artifacts/review.zip".into())],
                vec![],
            ),
            (200, vec![], bytes),
        ])
        .await;
        let client = SkillHubClient::new(&url, "test-token").unwrap();
        let bytes = client.download("team--review").await.unwrap();
        let files = unpack_package(&bytes).unwrap();
        let root = tempfile::tempdir().unwrap();
        let origin = client.installation_id("team--review").unwrap();
        install_package(root.path(), "team--review", &files, &origin).unwrap();
        let skill = root.path().join("team--review");
        assert_eq!(
            std::fs::read(skill.join("references/rules.md")).unwrap(),
            b"Rules"
        );
        assert_eq!(
            read_installation_source(&skill).await.as_deref(),
            Some(origin.as_str())
        );
        assert!(install_package(root.path(), "team--review", &files, &origin).is_err());
        let requests = requests.lock().unwrap();
        assert!(requests[0].starts_with("GET /hub/api/v1/skills/team/review/download "));
        assert!(requests.iter().all(|request| request
            .to_lowercase()
            .contains("authorization: bearer test-token")));
    }

    #[tokio::test]
    async fn errors_do_not_become_empty_results_or_leak_credentials() {
        for status in [401, 403, 500] {
            let (url, _) = server(vec![(status, vec![], b"secret-server-detail".to_vec())]).await;
            let error = SkillHubClient::new(&url, "test-token")
                .unwrap()
                .search("review", 20)
                .await
                .unwrap_err();
            assert!(!error.contains("test-token"));
            assert!(!error.contains("secret-server-detail"));
        }
        let (url, _) = server(vec![(
            200,
            vec![("Content-Type", "application/json".into())],
            br#"{"skills":[]}"#.to_vec(),
        )])
        .await;
        assert!(SkillHubClient::new(&url, "")
            .unwrap()
            .search("", 20)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn redirect_to_another_origin_does_not_forward_the_api_token() {
        let bytes = package(&[("SKILL.md", b"skill")]);
        let (artifact_url, requests) = server(vec![(200, vec![], bytes)]).await;
        let (url, _) = server(vec![(302, vec![("Location", artifact_url)], vec![])]).await;
        SkillHubClient::new(&url, "test-token")
            .unwrap()
            .download("review")
            .await
            .unwrap();
        assert!(!requests.lock().unwrap()[0]
            .to_lowercase()
            .contains("authorization:"));
    }

    #[test]
    fn archive_preserves_executable_permissions_and_rejects_symlinks() {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("SKILL.md", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"skill").unwrap();
        zip.start_file(
            "scripts/check.sh",
            zip::write::SimpleFileOptions::default().unix_permissions(0o755),
        )
        .unwrap();
        zip.write_all(b"#!/bin/sh\nexit 0\n").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let files = unpack_package(&bytes).unwrap();
        let root = tempfile::tempdir().unwrap();
        install_package(
            root.path(),
            "review",
            &files,
            "skillhub:https://corp#review",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.path().join("review/scripts/check.sh"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o755
            );
        }
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("SKILL.md", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"skill").unwrap();
        zip.add_symlink(
            "link",
            "../outside",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        assert!(unpack_package(&zip.finish().unwrap().into_inner()).is_err());
    }

    #[test]
    fn marketplace_identity_rejects_stale_items_and_unsafe_coordinates() {
        let client = SkillHubClient::new("https://skills.example/hub/", "").unwrap();
        let id = client.installation_id("team--review").unwrap();
        assert_eq!(
            client.slug_from_installation_id(&id).unwrap(),
            "team--review"
        );
        let other = SkillHubClient::new("https://other.example", "").unwrap();
        assert!(other.slug_from_installation_id(&id).is_err());
        for slug in ["..", "../review", "review\\file", "review@latest"] {
            assert!(client.installation_id(slug).is_err());
        }
        for url in [
            "file:///tmp/hub",
            "https://user:token@skills.example",
            "https://skills.example?token=x",
        ] {
            assert!(SkillHubClient::new(url, "").is_err());
        }
    }

    #[test]
    fn zip_validation_rejects_traversal_case_collisions_and_missing_entrypoint() {
        for entries in [
            vec![
                ("../outside", b"bad".as_slice()),
                ("SKILL.md", b"skill".as_slice()),
            ],
            vec![
                ("C:\\outside", b"bad".as_slice()),
                ("SKILL.md", b"skill".as_slice()),
            ],
            vec![("rules.md", b"rules".as_slice())],
            vec![
                ("SKILL.md", b"skill".as_slice()),
                ("SKILL.md.", b"alias".as_slice()),
            ],
            vec![
                ("SKILL.md", b"skill".as_slice()),
                ("NUL", b"device".as_slice()),
            ],
            vec![
                ("SKILL.md", b"skill".as_slice()),
                ("skill.md", b"duplicate".as_slice()),
            ],
            vec![
                (ORIGIN_FILE, b"spoofed".as_slice()),
                ("SKILL.md", b"skill".as_slice()),
            ],
        ] {
            assert!(unpack_package(&package(&entries)).is_err());
        }
    }
}
