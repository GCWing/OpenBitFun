//! Verified, staged deployment of a local directory through workspace IO ports.
//!
//! The caller owns Skill selection and the cache location. This owner supplies
//! the concrete archive, transfer, integrity and publication behavior.

use anyhow::{bail, Context, Result};
use openbitfun_runtime_ports::{WorkspaceCommandOptions, WorkspaceFileSystem, WorkspaceShell};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const MANIFEST_NAME: &str = ".openbitfun-package-manifest.json";
const REMOTE_HELPER: &str = include_str!("skill_package_sync.py");

#[cfg(test)]
#[path = "skill_package_sync_tests.rs"]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillPackageSyncPhase {
    Scanning,
    Checking,
    Uploading,
    Extracting,
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

struct LocalArchive {
    path: PathBuf,
    root: PathBuf,
    manifest: Manifest,
    manifest_bytes: Vec<u8>,
    package_id: String,
    content_hash: String,
    file_count: usize,
    total_bytes: u64,
    archive_bytes: u64,
    archive_created: bool,
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

impl Drop for LocalArchive {
    fn drop(&mut self) {
        if self.archive_created {
            let _ = fs::remove_file(&self.path);
        }
    }
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

/// Copy a complete local package only when the target does not contain a
/// byte-for-byte, mode-for-mode matching tree. No workspace file IO is redirected
/// to the local host. Python 3 on the POSIX target is an explicit prerequisite.
/// The selected workspace is the trusted boundary for symlink resolution;
/// the managed cache must be nested inside it and contain no symlink components.
///
/// Files are compressed once and sent in one streamed upload, avoiding one SSH
/// round trip per small file. Target verification also runs in one command.
pub async fn sync_local_skill_package(
    local_root: &Path,
    remote_cache_root: &str,
    remote_workspace_root: &str,
    package_key: &str,
    fs: &dyn WorkspaceFileSystem,
    shell: &dyn WorkspaceShell,
    progress: Option<SkillPackageProgressCallback>,
) -> Result<SkillPackageDeployment> {
    validate_remote_cache_location(remote_cache_root, remote_workspace_root)?;
    // Dropping the async invocation stops the blocking scan/packing worker at
    // its next entry/chunk rather than leaving a large package running.
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
    let archive =
        tokio::task::spawn_blocking(move || scan_package(&root, &key, &callback, cancelled))
            .await
            .context("Local Skill package scan failed")??;

    report(
        &progress,
        SkillPackageSyncPhase::Checking,
        archive.file_count,
        archive.total_bytes,
        0,
    );
    let check = remote_command(
        shell,
        "check",
        remote_cache_root,
        remote_workspace_root,
        &archive,
        "",
    )
    .await?;
    let destination = check.path;
    if check.reused {
        report(
            &progress,
            SkillPackageSyncPhase::Complete,
            archive.file_count,
            archive.total_bytes,
            0,
        );
        return Ok(deployment(&archive, destination, true));
    }

    // Compression and temporary archive IO are unnecessary on a cache hit.
    // Re-read and hash while packing so a source edit cannot pair stale
    // instructions with newer resources.
    report(
        &progress,
        SkillPackageSyncPhase::Scanning,
        archive.file_count,
        archive.total_bytes,
        0,
    );
    let archive = tokio::task::spawn_blocking(move || build_archive(archive))
        .await
        .context("Local Skill package preparation failed")??;
    let upload_name = format!(".upload-{}.zip", uuid::Uuid::new_v4());
    let remote_archive = format!(
        "{}/{}/{}",
        remote_cache_root.trim_end_matches('/'),
        archive.package_id,
        upload_name
    );
    let transfer = async {
        report(
            &progress,
            SkillPackageSyncPhase::Uploading,
            archive.file_count,
            archive.total_bytes,
            0,
        );
        let mut output = fs
            .open_write_new(&remote_archive)
            .await
            .context("Target does not support streaming Skill package uploads")?;
        let mut input = tokio::fs::File::open(&archive.path).await?;
        let mut buffer = vec![0; 64 * 1024];
        let mut transferred = 0;
        loop {
            let read = input.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            output.write_all(&buffer[..read]).await?;
            transferred += read as u64;
            report(
                &progress,
                SkillPackageSyncPhase::Uploading,
                archive.file_count,
                archive.archive_bytes,
                transferred,
            );
        }
        output.shutdown().await?;
        drop(output);
        report(
            &progress,
            SkillPackageSyncPhase::Extracting,
            archive.file_count,
            archive.total_bytes,
            transferred,
        );
        remote_command(
            shell,
            "publish",
            remote_cache_root,
            remote_workspace_root,
            &archive,
            &upload_name,
        )
        .await
    }
    .await;
    // Never remove a published directory when an observer or transfer fails.
    // A hard disconnect can leave only an unreferenced upload/staging sibling.
    let _ = fs.remove_file(&remote_archive).await;
    let published = transfer?;
    report(
        &progress,
        SkillPackageSyncPhase::Complete,
        archive.file_count,
        archive.total_bytes,
        archive.archive_bytes,
    );
    Ok(deployment(&archive, published.path, published.reused))
}

fn deployment(archive: &LocalArchive, path: String, reused: bool) -> SkillPackageDeployment {
    SkillPackageDeployment {
        path,
        content_hash: archive.content_hash.clone(),
        file_count: archive.file_count,
        total_bytes: archive.total_bytes,
        reused,
    }
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

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[derive(Deserialize)]
struct RemoteResult {
    path: String,
    reused: bool,
}

async fn remote_command(
    shell: &dyn WorkspaceShell,
    action: &str,
    cache_root: &str,
    workspace_root: &str,
    archive: &LocalArchive,
    upload_name: &str,
) -> Result<RemoteResult> {
    let arguments = [
        REMOTE_HELPER,
        action,
        cache_root,
        workspace_root,
        &archive.package_id,
        &archive.content_hash,
        upload_name,
    ]
    .map(quote)
    .join(" ");
    let result = shell
        .exec_with_options(
            &format!(
                "command -v python3 >/dev/null 2>&1 || {{ printf '%s\\n' 'Full user Skill sync requires Python 3 on the remote target' >&2; exit 127; }}; python3 -c {arguments}"
            ),
            // Hashing many files and extracting an archive may legitimately
            // take minutes. The transport and turn owner handle cancellation.
            WorkspaceCommandOptions::default(),
        )
        .await
        .context("Remote Skill package synchronization failed")?;
    if result.exit_code != 0 || result.interrupted || result.timed_out {
        bail!(
            "Remote Skill package {action} failed: {}",
            result.combined_output().trim()
        );
    }
    let result: RemoteResult = serde_json::from_str(result.stdout.trim())
        .context("Remote Skill package helper returned an invalid result")?;
    let expected = format!(
        "{}/{}/{}",
        cache_root.trim_end_matches('/'),
        archive.package_id,
        archive.content_hash
    );
    if result.path != expected {
        bail!("Remote Skill package helper returned an unexpected deployment path");
    }
    Ok(result)
}

fn scan_package(
    local_root: &Path,
    key: &str,
    progress: &Option<SkillPackageProgressCallback>,
    cancelled: Arc<AtomicBool>,
) -> Result<LocalArchive> {
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
    let archive_path = std::env::temp_dir().join(format!(
        "openbitfun-skill-package-{}.zip",
        uuid::Uuid::new_v4()
    ));
    let mut archive = LocalArchive {
        path: archive_path,
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
        archive_bytes: 0,
        archive_created: false,
        cancelled,
    };
    let mut manifest = Manifest {
        version: 1,
        entries: Vec::new(),
    };
    scan_directory(&root, "", &mut manifest.entries, &mut archive, progress)?;
    manifest.entries.sort_by(|a, b| a.path.cmp(&b.path));
    archive.manifest_bytes = serde_json::to_vec(&manifest)?;
    archive.content_hash = format!("{:x}", Sha256::digest(&archive.manifest_bytes));
    archive.manifest = manifest;
    Ok(archive)
}

fn scan_directory(
    directory: &Path,
    prefix: &str,
    manifest: &mut Vec<ManifestEntry>,
    archive: &mut LocalArchive,
    progress: &Option<SkillPackageProgressCallback>,
) -> Result<()> {
    let mut children = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        check_cancelled(&archive.cancelled)?;
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
            scan_directory(&path, &relative, manifest, archive, progress)?;
        } else if metadata.is_file() {
            entry.kind = "file";
            let mut input = File::open(&path)?;
            let mut digest = Sha256::new();
            let mut buffer = [0; 64 * 1024];
            loop {
                check_cancelled(&archive.cancelled)?;
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
            archive.file_count += 1;
            archive.total_bytes += entry.size;
            report(
                progress,
                SkillPackageSyncPhase::Scanning,
                archive.file_count,
                archive.total_bytes,
                0,
            );
        } else {
            bail!("Full user Skill sync only supports regular files and directories: {relative}");
        }
        manifest.push(entry);
    }
    Ok(())
}

fn build_archive(mut archive: LocalArchive) -> Result<LocalArchive> {
    let mut options = File::options();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&archive.path)?;
    archive.archive_created = true;
    let mut zip = ZipWriter::new(file);
    for entry in &archive.manifest.entries {
        check_cancelled(&archive.cancelled)?;
        let path = archive.root.join(&entry.path);
        let metadata = fs::symlink_metadata(&path)?;
        if crate::bounded_fs::is_symlink_or_reparse(&metadata)
            || local_mode(&metadata) != entry.mode
            || !fs::canonicalize(&path)?.starts_with(&archive.root)
        {
            bail!("Local Skill package changed while preparing its archive: {}. Try loading the Skill again", entry.path);
        }
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(entry.mode);
        if entry.kind == "directory" {
            if !metadata.is_dir() {
                bail!(
                    "Local Skill directory changed while preparing its archive: {}",
                    entry.path
                );
            }
            zip.add_directory(format!("{}/", entry.path), options)?;
            continue;
        }
        if !metadata.is_file() {
            bail!(
                "Local Skill file changed while preparing its archive: {}",
                entry.path
            );
        }
        let mut input = File::open(&path)?;
        let mut digest = Sha256::new();
        let mut size = 0;
        zip.start_file(&entry.path, options)?;
        let mut buffer = [0; 64 * 1024];
        loop {
            check_cancelled(&archive.cancelled)?;
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            zip.write_all(&buffer[..read])?;
            digest.update(&buffer[..read]);
            size += read as u64;
        }
        if size != entry.size || format!("{:x}", digest.finalize()) != entry.sha256 {
            bail!("Local Skill file changed while preparing its archive: {}. Try loading the Skill again", entry.path);
        }
    }
    zip.start_file(MANIFEST_NAME, SimpleFileOptions::default())?;
    zip.write_all(&archive.manifest_bytes)?;
    archive.archive_bytes = zip.finish()?.metadata()?.len();
    Ok(archive)
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
