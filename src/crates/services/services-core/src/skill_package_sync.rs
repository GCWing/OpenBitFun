//! Verified, staged directory deployment through workspace filesystem ports.
//!
//! Hashing and synchronization run on the host. The target needs only its bound
//! filesystem provider (SFTP for SSH); no interpreter or remote command runs.

use anyhow::{bail, Context, Result};
use futures::{stream, FutureExt, StreamExt, TryStreamExt};
use openbitfun_runtime_ports::{WorkspaceFileSystem, WorkspaceMetadata, WorkspacePathKind};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MANIFEST_NAME: &str = ".openbitfun-package-manifest.json";
// A bounded number of independent streams hides small-file round-trip latency
// without exhausting a connection's SFTP handle budget.
const MAX_FILE_TRANSFERS: usize = 4;
const STREAM_BUFFER_BYTES: usize = 64 * 1024;

#[cfg(test)]
#[path = "skill_package_sync_tests.rs"]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillPackageSyncPhase {
    Scanning,
    Checking,
    Uploading,
    Verifying,
    Complete,
}

#[derive(Clone, Debug)]
pub struct SkillPackageSyncProgress {
    pub phase: SkillPackageSyncPhase,
    pub file_count: usize,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
}

pub type SkillPackageProgressCallback = Arc<dyn Fn(SkillPackageSyncProgress) + Send + Sync>;

#[derive(Clone, Debug)]
pub struct SkillPackageDeployment {
    /// Absolute POSIX path on the target, independent of the controller OS.
    pub path: String,
    pub content_hash: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub reused: bool,
}

#[derive(Serialize)]
struct Manifest {
    version: u8,
    entries: Vec<ManifestEntry>,
}

#[derive(Serialize)]
struct ManifestEntry {
    path: String,
    kind: &'static str,
    mode: u32,
    size: u64,
    sha256: String,
}

struct LocalPackage {
    root: PathBuf,
    manifest: Manifest,
    manifest_bytes: Vec<u8>,
    package_id: String,
    content_hash: String,
    file_count: usize,
    total_bytes: u64,
    cancelled: Arc<AtomicBool>,
}

struct CancelLocalWork(Arc<AtomicBool>);
impl Drop for CancelLocalWork {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        bail!("Local Skill package preparation was cancelled");
    }
    Ok(())
}

fn report(
    callback: &Option<SkillPackageProgressCallback>,
    phase: SkillPackageSyncPhase,
    file_count: usize,
    total_bytes: u64,
    transferred_bytes: u64,
) {
    if let Some(callback) = callback {
        callback(SkillPackageSyncProgress {
            phase,
            file_count,
            total_bytes,
            transferred_bytes,
        });
    }
}

/// Deploy a complete local directory through filesystem operations only. Cache
/// hits still verify all bytes, modes and directory entries. Misses stream files
/// concurrently into an exclusive staging directory and publish only after full
/// target verification. The target needs no Python, shell, tar, unzip or rsync.
///
/// The selected workspace is trusted and may have symlink ancestors; every
/// managed cache component below that boundary must be a plain directory. Old
/// version-1 manifest/digest directories remain readable and reusable.
pub async fn sync_local_skill_package(
    local_root: &Path,
    remote_cache_root: &str,
    remote_workspace_root: &str,
    package_key: &str,
    fs: &dyn WorkspaceFileSystem,
    progress: Option<SkillPackageProgressCallback>,
) -> Result<SkillPackageDeployment> {
    validate_remote_cache_location(remote_cache_root, remote_workspace_root)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel_local_work = CancelLocalWork(cancelled.clone());
    let progress: Option<SkillPackageProgressCallback> = progress.map(|callback| {
        let last = Mutex::new(None::<(SkillPackageSyncPhase, Instant)>);
        Arc::new(move |event: SkillPackageSyncProgress| {
            let now = Instant::now();
            let mut last = last.lock().unwrap_or_else(|error| error.into_inner());
            if last.is_some_and(|(phase, time)| {
                phase == event.phase && now.duration_since(time) < Duration::from_millis(250)
            }) {
                return;
            }
            *last = Some((event.phase, now));
            drop(last);
            callback(event);
        }) as SkillPackageProgressCallback
    });
    report(&progress, SkillPackageSyncPhase::Scanning, 0, 0, 0);
    let root = local_root.to_owned();
    let key = package_key.to_owned();
    let callback = progress.clone();
    let package =
        tokio::task::spawn_blocking(move || scan_package(&root, &key, &callback, cancelled))
            .await
            .context("Local Skill package scan failed")??;
    report(
        &progress,
        SkillPackageSyncPhase::Checking,
        package.file_count,
        package.total_bytes,
        0,
    );
    ensure_cache_root(fs, remote_cache_root, remote_workspace_root).await?;
    let parent = remote_join(remote_cache_root, &package.package_id);
    ensure_plain_directory(fs, &parent).await?;
    if let Some(target) = find_verified_deployment(fs, &parent, &package).await? {
        report(
            &progress,
            SkillPackageSyncPhase::Complete,
            package.file_count,
            package.total_bytes,
            0,
        );
        return Ok(deployment(&package, target, true));
    }

    let staging = remote_join(&parent, &format!(".staging-{}", uuid::Uuid::new_v4()));
    fs.create_dir_new(&staging)
        .await
        .context("Target does not support exclusive Skill staging directories")?;
    let result = async {
        fs.set_permissions(&staging, 0o700).await?;
        upload_package(fs, &staging, &package, &progress).await?;
        report(
            &progress,
            SkillPackageSyncPhase::Verifying,
            package.file_count,
            package.total_bytes,
            package.total_bytes,
        );
        if !verify_remote_package(fs, &staging, &package).await? {
            bail!("Uploaded Skill package failed full integrity verification");
        }
        let (target, reused) = publish_package(fs, &staging, &parent, &package).await?;
        Ok::<_, anyhow::Error>(deployment(&package, target, reused))
    }
    .await;
    // Never remove a published directory on failure. Interrupted transfers may
    // leave an unreferenced staging sibling if the target is disconnected.
    let _ = fs.remove_dir(&staging, true).await;
    let deployed = result?;
    report(
        &progress,
        SkillPackageSyncPhase::Complete,
        package.file_count,
        package.total_bytes,
        package.total_bytes,
    );
    Ok(deployed)
}

fn deployment(package: &LocalPackage, path: String, reused: bool) -> SkillPackageDeployment {
    SkillPackageDeployment {
        path,
        content_hash: package.content_hash.clone(),
        file_count: package.file_count,
        total_bytes: package.total_bytes,
        reused,
    }
}

fn remote_join(root: &str, relative: &str) -> String {
    format!("{}/{}", root.trim_end_matches('/'), relative)
}

fn validate_remote_root(root: &str) -> Result<()> {
    if !root.starts_with('/')
        || root.contains('\0')
        || root.split('/').any(|part| matches!(part, "." | ".."))
    {
        bail!("Skill package cache requires an absolute POSIX target path without dot segments");
    }
    Ok(())
}

fn validate_remote_cache_location(cache: &str, workspace: &str) -> Result<()> {
    validate_remote_root(cache)?;
    validate_remote_root(workspace)?;
    let workspace: Vec<_> = workspace
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let cache: Vec<_> = cache.split('/').filter(|part| !part.is_empty()).collect();
    if cache.len() <= workspace.len() || !cache.starts_with(&workspace) {
        bail!("Skill package cache must be inside the selected remote workspace");
    }
    Ok(())
}

async fn ensure_plain_directory(fs: &dyn WorkspaceFileSystem, path: &str) -> Result<()> {
    match fs.metadata(path, false).await? {
        Some(metadata) if metadata.kind == WorkspacePathKind::Directory => Ok(()),
        Some(_) => bail!("Skill cache path must be a directory without symbolic links: {path}"),
        None => {
            if let Err(error) = fs.create_dir_new(path).await {
                // Another invocation may have created this shared component.
                if fs
                    .metadata(path, false)
                    .await?
                    .is_some_and(|m| m.kind == WorkspacePathKind::Directory)
                {
                    return Ok(());
                }
                return Err(error).context("Failed to create a plain Skill cache directory");
            }
            fs.set_permissions(path, 0o700).await?;
            Ok(())
        }
    }
}

async fn ensure_cache_root(
    fs: &dyn WorkspaceFileSystem,
    cache: &str,
    workspace: &str,
) -> Result<()> {
    let root = fs
        .metadata(workspace, true)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Selected remote workspace is unavailable"))?;
    if root.kind != WorkspacePathKind::Directory {
        bail!("Selected remote workspace is not a directory");
    }
    let root_parts = workspace.split('/').filter(|part| !part.is_empty()).count();
    let mut path = workspace.trim_end_matches('/').to_string();
    for component in cache
        .split('/')
        .filter(|part| !part.is_empty())
        .skip(root_parts)
    {
        path = remote_join(&path, component);
        ensure_plain_directory(fs, &path).await?;
    }
    Ok(())
}

fn permissions(metadata: &WorkspaceMetadata) -> Result<u32> {
    metadata
        .permissions
        .map(|mode| mode & 0o777)
        .ok_or_else(|| {
            anyhow::anyhow!("Full user Skill sync requires filesystem POSIX permission metadata")
        })
}

async fn verify_remote_package(
    fs: &dyn WorkspaceFileSystem,
    root: &str,
    package: &LocalPackage,
) -> Result<bool> {
    let Some(metadata) = fs.metadata(root, false).await? else {
        return Ok(false);
    };
    if metadata.kind != WorkspacePathKind::Directory || permissions(&metadata)? != 0o700 {
        return Ok(false);
    }
    let marker = remote_join(root, MANIFEST_NAME);
    let Some(metadata) = fs.metadata(&marker, false).await? else {
        return Ok(false);
    };
    if metadata.kind != WorkspacePathKind::File {
        return Ok(false);
    }
    let mut reader = fs
        .open_read(&marker)
        .await
        .context("Target does not support streamed Skill verification")?;
    let mut buffer = vec![0; STREAM_BUFFER_BYTES];
    let mut offset = 0;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        if offset + read > package.manifest_bytes.len()
            || buffer[..read] != package.manifest_bytes[offset..offset + read]
        {
            return Ok(false);
        }
        offset += read;
    }
    if offset != package.manifest_bytes.len() {
        return Ok(false);
    }
    drop(reader);

    let expected: HashMap<_, _> = package
        .manifest
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let mut seen = HashSet::new();
    let mut directories = vec![String::new()];
    while let Some(relative) = directories.pop() {
        let directory = if relative.is_empty() {
            root.to_string()
        } else {
            remote_join(root, &relative)
        };
        let Some(metadata) = fs.metadata(&directory, false).await? else {
            return Ok(false);
        };
        if metadata.kind != WorkspacePathKind::Directory {
            return Ok(false);
        }
        if !relative.is_empty() && permissions(&metadata)? != expected[relative.as_str()].mode {
            return Ok(false);
        }
        for child in fs.read_dir(&directory).await? {
            if child.name.is_empty()
                || matches!(child.name.as_str(), "." | "..")
                || child.name.contains(['/', '\\', '\0'])
            {
                bail!("Target returned an invalid Skill package entry name");
            }
            let name = if relative.is_empty() {
                child.name
            } else {
                format!("{relative}/{}", child.name)
            };
            if name == MANIFEST_NAME {
                continue;
            }
            let Some(entry) = expected.get(name.as_str()) else {
                return Ok(false);
            };
            if child.is_symlink || !seen.insert(name.clone()) {
                return Ok(false);
            }
            if entry.kind == "directory" {
                directories.push(name);
            }
        }
    }
    if seen.len() != expected.len() {
        return Ok(false);
    }
    let checks: Vec<_> = package
        .manifest
        .entries
        .iter()
        .map(|entry| verify_remote_entry(fs, root, entry).boxed())
        .collect();
    let mut checks = stream::iter(checks).buffer_unordered(MAX_FILE_TRANSFERS);
    while let Some(valid) = checks.next().await {
        if !valid? {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn verify_remote_entry(
    fs: &dyn WorkspaceFileSystem,
    root: &str,
    entry: &ManifestEntry,
) -> Result<bool> {
    let path = remote_join(root, &entry.path);
    let Some(metadata) = fs.metadata(&path, false).await? else {
        return Ok(false);
    };
    let kind = if entry.kind == "directory" {
        WorkspacePathKind::Directory
    } else {
        WorkspacePathKind::File
    };
    if metadata.kind != kind || permissions(&metadata)? != entry.mode {
        return Ok(false);
    }
    if entry.kind == "directory" {
        return Ok(true);
    }
    if metadata.size.is_some_and(|size| size != entry.size) {
        return Ok(false);
    }
    let mut reader = fs
        .open_read(&path)
        .await
        .context("Target does not support streamed Skill verification")?;
    let mut buffer = vec![0; STREAM_BUFFER_BYTES];
    let mut digest = Sha256::new();
    let mut size = 0;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > entry.size {
            return Ok(false);
        }
        digest.update(&buffer[..read]);
    }
    Ok(size == entry.size && format!("{:x}", digest.finalize()) == entry.sha256)
}

async fn upload_package(
    fs: &dyn WorkspaceFileSystem,
    staging: &str,
    package: &LocalPackage,
    progress: &Option<SkillPackageProgressCallback>,
) -> Result<()> {
    let mut directories: Vec<_> = package
        .manifest
        .entries
        .iter()
        .filter(|entry| entry.kind == "directory")
        .collect();
    directories.sort_by_key(|entry| entry.path.split('/').count());
    for entry in &directories {
        let path = remote_join(staging, &entry.path);
        fs.create_dir_new(&path).await?;
        fs.set_permissions(&path, 0o700).await?;
    }
    report(
        progress,
        SkillPackageSyncPhase::Uploading,
        package.file_count,
        package.total_bytes,
        0,
    );
    let transferred = AtomicU64::new(0);
    let uploads: Vec<_> = package
        .manifest
        .entries
        .iter()
        .filter(|entry| entry.kind == "file")
        .map(|entry| upload_file(fs, staging, package, entry, progress, &transferred).boxed())
        .collect();
    stream::iter(uploads)
        .buffer_unordered(MAX_FILE_TRANSFERS)
        .try_collect::<Vec<_>>()
        .await?;
    let marker = remote_join(staging, MANIFEST_NAME);
    let mut writer = fs
        .open_write_new(&marker)
        .await
        .context("Target does not support streaming Skill package uploads")?;
    writer.write_all(&package.manifest_bytes).await?;
    writer.shutdown().await?;
    drop(writer);
    fs.set_permissions(&marker, 0o600).await?;
    for entry in directories.into_iter().rev() {
        fs.set_permissions(&remote_join(staging, &entry.path), entry.mode)
            .await?;
    }
    Ok(())
}

async fn upload_file(
    fs: &dyn WorkspaceFileSystem,
    staging: &str,
    package: &LocalPackage,
    entry: &ManifestEntry,
    progress: &Option<SkillPackageProgressCallback>,
    transferred: &AtomicU64,
) -> Result<()> {
    check_cancelled(&package.cancelled)?;
    let path = package.root.join(&entry.path);
    let metadata = tokio::fs::symlink_metadata(&path).await?;
    if crate::bounded_fs::is_symlink_or_reparse(&metadata)
        || !metadata.is_file()
        || local_mode(&metadata) != entry.mode
        || !tokio::fs::canonicalize(&path)
            .await?
            .starts_with(&package.root)
    {
        bail!("Local Skill package changed while preparing its transfer: {}. Try loading the Skill again", entry.path);
    }
    let mut input = tokio::fs::File::open(&path).await?;
    let target = remote_join(staging, &entry.path);
    let mut output = fs
        .open_write_new(&target)
        .await
        .context("Target does not support streaming Skill package uploads")?;
    let mut buffer = vec![0; STREAM_BUFFER_BYTES];
    let mut digest = Sha256::new();
    let mut size = 0;
    loop {
        check_cancelled(&package.cancelled)?;
        let read = input.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        size += read as u64;
        if size > entry.size {
            bail!("Local Skill file changed while preparing its transfer: {}. Try loading the Skill again", entry.path);
        }
        output.write_all(&buffer[..read]).await?;
        let transferred = transferred.fetch_add(read as u64, Ordering::Relaxed) + read as u64;
        report(
            progress,
            SkillPackageSyncPhase::Uploading,
            package.file_count,
            package.total_bytes,
            transferred,
        );
    }
    if size != entry.size || format!("{:x}", digest.finalize()) != entry.sha256 {
        bail!("Local Skill file changed while preparing its transfer: {}. Try loading the Skill again", entry.path);
    }
    output.shutdown().await?;
    drop(output);
    fs.set_permissions(&target, entry.mode).await?;
    Ok(())
}

async fn find_verified_deployment(
    fs: &dyn WorkspaceFileSystem,
    parent: &str,
    package: &LocalPackage,
) -> Result<Option<String>> {
    let mut candidates: Vec<_> = fs
        .read_dir(parent)
        .await?
        .into_iter()
        .filter_map(|entry| {
            let is_legacy = entry.name == package.content_hash;
            let is_generation = entry
                .name
                .strip_prefix(&format!("{}-", package.content_hash))
                .is_some_and(|suffix| {
                    uuid::Uuid::parse_str(suffix)
                        .is_ok_and(|id| id.hyphenated().to_string() == suffix)
                });
            (is_legacy || is_generation).then_some(entry.name)
        })
        .collect();
    // Prefer newer-format generations over legacy fixed-digest directories.
    // UUID order is not chronology; all verified generations contain the same
    // immutable bytes. This merely makes the selection deterministic.
    candidates.sort_by(|left, right| right.cmp(left));
    for name in candidates {
        let path = remote_join(parent, &name);
        if verify_remote_package(fs, &path, package).await? {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

async fn publish_package(
    fs: &dyn WorkspaceFileSystem,
    staging: &str,
    parent: &str,
    package: &LocalPackage,
) -> Result<(String, bool)> {
    if let Some(winner) = find_verified_deployment(fs, parent, package).await? {
        return Ok((winner, true));
    }
    let target = remote_join(
        parent,
        &format!("{}-{}", package.content_hash, uuid::Uuid::new_v4()),
    );
    fs.rename(staging, &target)
        .await
        .context("Skill package publication failed; existing deployments were preserved")?;
    // Each publisher owns its UUID destination. A concurrent repair can never
    // move a path another invocation has already returned. Corrupt generations
    // remain intact, and readers discover any verified generation next time.
    Ok((target, false))
}

fn scan_package(
    local_root: &Path,
    key: &str,
    progress: &Option<SkillPackageProgressCallback>,
    cancelled: Arc<AtomicBool>,
) -> Result<LocalPackage> {
    check_cancelled(&cancelled)?;
    let root = fs::canonicalize(local_root)
        .with_context(|| format!("Cannot read local Skill directory {}", local_root.display()))?;
    if !root.is_dir() {
        bail!("Local Skill package is not a directory: {}", root.display());
    }
    let package_id = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(key, root.to_string_lossy()))?)
    );
    let mut package = LocalPackage {
        root: root.clone(),
        manifest: Manifest {
            version: 1,
            entries: Vec::new(),
        },
        manifest_bytes: Vec::new(),
        package_id,
        content_hash: String::new(),
        file_count: 0,
        total_bytes: 0,
        cancelled,
    };
    let mut manifest = Manifest {
        version: 1,
        entries: Vec::new(),
    };
    scan_directory(&root, "", &mut manifest.entries, &mut package, progress)?;
    manifest.entries.sort_by(|a, b| a.path.cmp(&b.path));
    package.manifest_bytes = serde_json::to_vec(&manifest)?;
    package.content_hash = format!("{:x}", Sha256::digest(&package.manifest_bytes));
    package.manifest = manifest;
    Ok(package)
}

fn scan_directory(
    directory: &Path,
    prefix: &str,
    manifest: &mut Vec<ManifestEntry>,
    package: &mut LocalPackage,
    progress: &Option<SkillPackageProgressCallback>,
) -> Result<()> {
    let mut children = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        check_cancelled(&package.cancelled)?;
        let name = child
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("Full user Skill sync requires UTF-8 file names"))?;
        if name.contains('\\') {
            bail!("Full user Skill sync cannot map a file name containing a backslash: {name}");
        }
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if relative == MANIFEST_NAME {
            bail!("Skill package contains the reserved file {MANIFEST_NAME}");
        }
        let path = child.path();
        let metadata = fs::symlink_metadata(&path)?;
        if crate::bounded_fs::is_symlink_or_reparse(&metadata) {
            bail!(
                "Full user Skill sync does not support nested symbolic links: {relative}. Replace the link with package-local files"
            );
        }
        let mode = local_mode(&metadata);
        let mut entry = ManifestEntry {
            path: relative.clone(),
            kind: "directory",
            mode,
            size: 0,
            sha256: String::new(),
        };
        if metadata.is_dir() {
            scan_directory(&path, &relative, manifest, package, progress)?;
        } else if metadata.is_file() {
            entry.kind = "file";
            let mut input = File::open(&path)?;
            let mut digest = Sha256::new();
            let mut buffer = [0; 64 * 1024];
            loop {
                check_cancelled(&package.cancelled)?;
                let read = input.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                digest.update(&buffer[..read]);
                entry.size += read as u64;
            }
            if input.metadata()?.modified().ok() != metadata.modified().ok()
                || entry.size != metadata.len()
            {
                bail!("Local Skill file changed while preparing its package: {relative}. Try loading the Skill again");
            }
            entry.sha256 = format!("{:x}", digest.finalize());
            package.file_count += 1;
            package.total_bytes += entry.size;
            report(
                progress,
                SkillPackageSyncPhase::Scanning,
                package.file_count,
                package.total_bytes,
                0,
            );
        } else {
            bail!("Full user Skill sync only supports regular files and directories: {relative}");
        }
        manifest.push(entry);
    }
    Ok(())
}

#[cfg(unix)]
fn local_mode(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o777
}

#[cfg(not(unix))]
fn local_mode(metadata: &fs::Metadata) -> u32 {
    if metadata.is_dir() {
        0o755
    } else {
        0o644
    }
}
