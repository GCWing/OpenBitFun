//! Workspace-confined static resources, shared by Desktop and CLI peer hosts.
//! The caller selects a workspace/provider; this service never falls back to another filesystem.

use super::file_projection::SessionFileTarget;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use openbitfun_product_domains::html_preview::{
    HtmlPreviewError, HtmlPreviewErrorCode as Code, HtmlPreviewResource,
    HtmlPreviewResourceRequest, MAX_PREVIEW_BYTES, PREVIEW_CHUNK_BYTES,
};
use openbitfun_runtime_ports::{WorkspaceFileSystem, WorkspaceMetadata, WorkspacePathKind};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub mod transfer;

pub struct HtmlPreviewSource {
    fs: Arc<dyn WorkspaceFileSystem>,
    root: String,
    remote: bool,
    entry_path: String,
    source: String,
}

type PreviewResult<T> = Result<T, HtmlPreviewError>;

impl HtmlPreviewSource {
    pub async fn new(target: SessionFileTarget, identity: &str) -> PreviewResult<Self> {
        let (root, entry_path) = if target.remote {
            let root = normalize_posix(&target.root)?;
            let entry = normalize_posix(&target.path)?;
            let prefix = format!("{}/", root.trim_end_matches('/'));
            let relative = entry.strip_prefix(&prefix).ok_or_else(outside_workspace)?;
            (root, relative.to_string())
        } else {
            let root = tokio::fs::canonicalize(&target.root)
                .await
                .map_err(local_io_error)?;
            let entry = tokio::fs::canonicalize(&target.path)
                .await
                .map_err(local_io_error)?;
            let relative = entry.strip_prefix(&root).map_err(|_| outside_workspace())?;
            let relative = relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            (root.to_string_lossy().into_owned(), relative)
        };
        validate_relative(&entry_path)?;
        let source = digest(&[
            identity,
            &root,
            &entry_path,
            if target.remote { "remote" } else { "local" },
        ]);
        let result = Self {
            fs: target.fs,
            root,
            remote: target.remote,
            entry_path,
            source,
        };
        result.checked_file(&result.entry_path).await?;
        Ok(result)
    }

    pub async fn read(
        &self,
        request: &HtmlPreviewResourceRequest,
    ) -> PreviewResult<HtmlPreviewResource> {
        if request
            .expected_source
            .as_deref()
            .is_some_and(|source| source != self.source)
        {
            return Err(HtmlPreviewError::new(
                Code::Changed,
                "HTML preview workspace changed; reopen the preview",
            ));
        }
        let candidates = match &request.resource_path {
            Some(path) => resource_candidates(&self.entry_path, path)?,
            None => vec![self.entry_path.clone()],
        };
        let mut resolved = None;
        for relative in candidates {
            match self.checked_file(&relative).await {
                Ok((path, metadata)) => {
                    resolved = Some((relative, path, metadata));
                    break;
                }
                Err(error) if error.code == Code::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        let (relative, path, before) = resolved.ok_or_else(not_found)?;
        let size = before
            .size
            .ok_or_else(|| HtmlPreviewError::unavailable("Preview file size is unavailable"))?;
        if size > MAX_PREVIEW_BYTES {
            return Err(HtmlPreviewError::new(
                Code::TooLarge,
                "Preview file is too large",
            ));
        }
        let modified = before
            .modified
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .ok_or_else(|| HtmlPreviewError::unavailable("Preview file revision is unavailable"))?;
        let revision = digest(&[
            &self.source,
            &relative,
            &size.to_string(),
            &modified.as_nanos().to_string(),
        ]);
        if request
            .expected_revision
            .as_deref()
            .is_some_and(|expected| expected != revision)
        {
            return Err(HtmlPreviewError::new(
                Code::Changed,
                "Preview file changed during transfer; reload the page",
            ));
        }
        if request.offset > size {
            return Err(HtmlPreviewError::new(
                Code::InvalidPath,
                "Invalid preview file offset",
            ));
        }
        let mut bytes = Vec::new();
        if !request.metadata_only {
            let count = (size - request.offset).min(PREVIEW_CHUNK_BYTES as u64);
            let mut reader = self.fs.open_read(&path).await.map_err(provider_error)?;
            reader
                .seek(std::io::SeekFrom::Start(request.offset))
                .await
                .map_err(provider_error)?;
            reader
                .take(count)
                .read_to_end(&mut bytes)
                .await
                .map_err(provider_error)?;
            let after = self
                .fs
                .metadata(&path, false)
                .await
                .map_err(provider_error)?;
            if after.as_ref() != Some(&before) || bytes.len() as u64 != count {
                return Err(HtmlPreviewError::new(
                    Code::Changed,
                    "Preview file changed during transfer; reload the page",
                ));
            }
        }
        Ok(HtmlPreviewResource {
            entry_path: self.entry_path.clone(),
            resource_path: relative,
            source: self.source.clone(),
            revision,
            mime_type: mime_for_path(&path),
            size,
            offset: request.offset,
            content_base64: BASE64.encode(bytes),
        })
    }

    async fn checked_file(&self, relative: &str) -> PreviewResult<(String, WorkspaceMetadata)> {
        validate_relative(relative)?;
        let parts: Vec<_> = relative
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .collect();
        let requested = self.fs.join_path(&self.root, &parts);
        let path = if self.remote {
            // POSIX paths on every controller OS. Check each component with no-follow metadata.
            let mut current = String::new();
            for part in requested.split('/').filter(|part| !part.is_empty()) {
                current.push('/');
                current.push_str(part);
                let metadata = self
                    .fs
                    .metadata(&current, false)
                    .await
                    .map_err(provider_error)?
                    .ok_or_else(not_found)?;
                if metadata.kind == WorkspacePathKind::Symlink {
                    return Err(HtmlPreviewError::new(
                        Code::Forbidden,
                        "Symbolic links are not available in remote HTML preview",
                    ));
                }
                if current == requested {
                    if metadata.kind != WorkspacePathKind::File {
                        return Err(not_found());
                    }
                    // Reuse the final no-follow lookup instead of paying for
                    // another SFTP round trip to the same path.
                    return Ok((requested, metadata));
                }
                if metadata.kind != WorkspacePathKind::Directory {
                    return Err(not_found());
                }
            }
            return Err(not_found());
        } else {
            let canonical = tokio::fs::canonicalize(&requested)
                .await
                .map_err(local_io_error)?;
            if !canonical.starts_with(Path::new(&self.root)) {
                return Err(outside_workspace());
            }
            canonical.to_string_lossy().into_owned()
        };
        let metadata = self
            .fs
            .metadata(&path, false)
            .await
            .map_err(provider_error)?
            .ok_or_else(not_found)?;
        if metadata.kind != WorkspacePathKind::File {
            return Err(not_found());
        }
        Ok((path, metadata))
    }
}

fn digest(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn normalize_posix(path: &str) -> PreviewResult<String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err(outside_workspace());
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(outside_workspace());
                }
            }
            part => parts.push(part),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

fn validate_relative(path: &str) -> PreviewResult<()> {
    if path.contains('\0')
        || path
            .split('/')
            .any(|part| part == ".." || part.contains('\\'))
    {
        return Err(HtmlPreviewError::new(
            Code::InvalidPath,
            "Invalid preview path",
        ));
    }
    Ok(())
}

fn resource_candidates(entry: &str, path: &str) -> PreviewResult<Vec<String>> {
    validate_relative(path)?;
    let relative = path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/");
    let relative = if path.ends_with('/') || relative.is_empty() {
        format!("{relative}/index.html")
            .trim_start_matches('/')
            .to_string()
    } else {
        relative
    };
    let directory = entry
        .rsplit_once('/')
        .map(|(directory, _)| directory)
        .unwrap_or("");
    // The entry keeps its workspace-relative URL, preserving ../ and explicitly prefixed links.
    // Root-relative build assets (/assets/...) resolve beside the selected HTML first.
    if directory.is_empty() || relative.starts_with(&format!("{directory}/")) {
        return Ok(vec![relative]);
    }
    Ok(vec![format!("{directory}/{relative}"), relative])
}

fn mime_for_path(path: &str) -> String {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let mime = match extension.as_str() {
        "cjs" => "text/javascript",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "webmanifest" => "application/manifest+json",
        "map" => "application/json",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "webm" => "video/webm",
        _ => super::detect_remote_mime_type(Path::new(path)),
    };
    if mime.starts_with("text/") {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    }
}

fn not_found() -> HtmlPreviewError {
    HtmlPreviewError::new(Code::NotFound, "Preview resource not found")
}
fn outside_workspace() -> HtmlPreviewError {
    HtmlPreviewError::new(
        Code::Forbidden,
        "HTML preview path is outside the workspace",
    )
}
fn provider_error(error: impl std::fmt::Display) -> HtmlPreviewError {
    HtmlPreviewError::unavailable(format!("Failed to read preview resource: {error}"))
}
fn local_io_error(error: std::io::Error) -> HtmlPreviewError {
    if error.kind() == std::io::ErrorKind::NotFound {
        not_found()
    } else {
        provider_error(error)
    }
}

#[cfg(test)]
mod tests;
