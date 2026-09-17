//! App-managed portable runtimes for the LoopX environment surface.
//!
//! The LoopX control plane needs a modern Node.js runtime (>= 22.6) and the
//! workspace lifecycle needs `git`. Requiring end users to install both at the
//! system level is the wrong default, so this module downloads pinned portable
//! builds into the BitFun-managed runtime root
//! (`<user-config>/openbitfun/runtimes/<component>/current`) and verifies them
//! against a pinned SHA-256 before the archive is unpacked.
//!
//! The managed layout is the one `ManagedRuntimeResolver` already understands,
//! so installed runtimes become visible to every BitFun child process (and to
//! the LoopX sidecar) without touching the system PATH.

use openbitfun_product_domains::miniapp::loopx::{
    LoopxCliInstallRuntimeResult, LoopxCliProgressSink, LoopxManagedRuntimeKind,
    LoopxCliProgressStage,
};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// Node.js LTS pinned for app-managed installs. Must stay >= the LoopX control
/// plane floor (`LOOPX_MINIMUM_NODE_VERSION`, currently 22.6.0).
pub const NODE_PINNED_VERSION: &str = "24.21.0";
/// Git for Windows release tag that ships the `MinGit` portable archives.
pub const GIT_PINNED_RELEASE_TAG: &str = "v2.55.0.windows.5";
/// Human-readable version of the pinned `MinGit` archives.
pub const GIT_PINNED_VERSION: &str = "2.55.0.5";
/// Download host for pinned Node.js distributions.
pub const NODE_DIST_BASE_URL: &str = "https://nodejs.org/dist";
/// Download host for pinned Git for Windows releases.
pub const GIT_RELEASE_BASE_URL: &str = "https://github.com/git-for-windows/git/releases/download";

const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(900);
const PROGRESS_STEP_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum LoopxRuntimeInstallError {
    #[error("no app-managed {runtime} runtime is available for this platform: {detail}")]
    UnsupportedPlatform {
        runtime: &'static str,
        detail: String,
    },
    #[error("failed to prepare the {runtime} runtime directory: {message}")]
    Prepare {
        runtime: &'static str,
        message: String,
    },
    #[error("failed to download {asset}: {message}")]
    Download { asset: String, message: String },
    #[error("checksum mismatch for {asset}: expected {expected}, got {actual}")]
    ChecksumMismatch {
        asset: String,
        expected: String,
        actual: String,
    },
    #[error("failed to unpack {asset}: {message}")]
    Extract { asset: String, message: String },
    #[error("the unpacked {runtime} archive is missing {path}")]
    MissingBinary {
        runtime: &'static str,
        path: String,
    },
    #[error("failed to activate the {runtime} runtime: {message}")]
    Activate {
        runtime: &'static str,
        message: String,
    },
    #[error("I/O error while installing a managed runtime: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    Zip,
    TarGz,
}

struct RuntimeArtifact {
    kind: LoopxManagedRuntimeKind,
    label: &'static str,
    component: &'static str,
    version: &'static str,
    asset: String,
    sha256: &'static str,
    url: String,
    archive: ArchiveKind,
    /// Candidate relative paths (checked in order) that must exist after unpack.
    binaries: &'static [&'static str],
    /// Relative path that must be marked executable on Unix hosts.
    unix_executable: Option<&'static str>,
}

/// Downloads and activates pinned portable runtimes under a managed root.
pub struct LoopxRuntimeInstaller {
    runtime_root: PathBuf,
    client: reqwest::Client,
}

impl LoopxRuntimeInstaller {
    pub fn new(runtime_root: impl Into<PathBuf>) -> Result<Self, LoopxRuntimeInstallError> {
        let client = crate::reqwest_client_builder()
            .user_agent("BitFun LoopX managed runtime installer")
            .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
            .timeout(DOWNLOAD_TIMEOUT)
            .build()
            .map_err(|error| LoopxRuntimeInstallError::Prepare {
                runtime: "managed",
                message: format!("failed to build the download client: {error}"),
            })?;
        Ok(Self {
            runtime_root: runtime_root.into(),
            client,
        })
    }

    pub fn runtime_root(&self) -> &Path {
        &self.runtime_root
    }

    /// Installs (or re-installs) the pinned runtime and returns its managed path.
    pub async fn install(
        &self,
        kind: LoopxManagedRuntimeKind,
        operation_id: &str,
        progress: &dyn LoopxCliProgressSink,
    ) -> Result<LoopxCliInstallRuntimeResult, LoopxRuntimeInstallError> {
        let artifact = artifact_for(kind)?;
        report_progress(
            progress,
            operation_id,
            format!("Downloading {} {}", artifact.label, artifact.version),
        );

        let component_root = self.runtime_root.join(artifact.component);
        tokio::fs::create_dir_all(&component_root).await?;
        let staging = component_root.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
        tokio::fs::create_dir_all(&staging).await?;

        let result = self
            .install_into_staging(&artifact, &component_root, &staging, operation_id, progress)
            .await;
        // Best-effort cleanup: the activated `current` directory no longer
        // depends on the staging directory once the rename succeeds.
        let _ = tokio::fs::remove_dir_all(&staging).await;
        result
    }

    async fn install_into_staging(
        &self,
        artifact: &RuntimeArtifact,
        component_root: &Path,
        staging: &Path,
        operation_id: &str,
        progress: &dyn LoopxCliProgressSink,
    ) -> Result<LoopxCliInstallRuntimeResult, LoopxRuntimeInstallError> {
        let archive_path = staging.join(&artifact.asset);
        self.download(artifact, &archive_path, operation_id, progress)
            .await?;

        report_progress(
            progress,
            operation_id,
            format!("Extracting {} {}", artifact.label, artifact.version),
        );
        let extracted = staging.join("extracted");
        let archive_path_for_task = archive_path.clone();
        let extracted_for_task = extracted.clone();
        let archive_kind = artifact.archive;
        tokio::task::spawn_blocking(move || {
            extract_archive(&archive_path_for_task, &extracted_for_task, archive_kind)
        })
        .await
        .map_err(|error| LoopxRuntimeInstallError::Extract {
            asset: artifact.asset.clone(),
            message: format!("extraction task failed: {error}"),
        })??;

        let content_root = resolve_content_root(&extracted)?;
        let missing = artifact
            .binaries
            .iter()
            .find(|binary| !content_root.join(binary).is_file());
        if let Some(missing) = missing {
            return Err(LoopxRuntimeInstallError::MissingBinary {
                runtime: artifact.label,
                path: content_root.join(missing).display().to_string(),
            });
        }
        if let Some(relative) = artifact.unix_executable {
            ensure_unix_executable(&content_root.join(relative))?;
        }

        report_progress(
            progress,
            operation_id,
            format!("Activating {} {}", artifact.label, artifact.version),
        );
        let target = component_root.join("current");
        activate_directory(&content_root, &target).map_err(|error| {
            LoopxRuntimeInstallError::Activate {
                runtime: artifact.label,
                message: error,
            }
        })?;
        Ok(LoopxCliInstallRuntimeResult {
            runtime: artifact.kind,
            version: artifact.version.to_string(),
            install_path: target.display().to_string(),
        })
    }

    async fn download(
        &self,
        artifact: &RuntimeArtifact,
        destination: &Path,
        operation_id: &str,
        progress: &dyn LoopxCliProgressSink,
    ) -> Result<(), LoopxRuntimeInstallError> {
        let mut response = self
            .client
            .get(&artifact.url)
            .send()
            .await
            .map_err(|error| LoopxRuntimeInstallError::Download {
                asset: artifact.asset.clone(),
                message: error.to_string(),
            })?
            .error_for_status()
            .map_err(|error| LoopxRuntimeInstallError::Download {
                asset: artifact.asset.clone(),
                message: error.to_string(),
            })?;
        let mut file = tokio::fs::File::create(destination).await?;
        let mut hasher = Sha256::new();
        let mut received: u64 = 0;
        let mut last_reported: u64 = 0;
        while let Some(chunk) =
            response
                .chunk()
                .await
                .map_err(|error| LoopxRuntimeInstallError::Download {
                    asset: artifact.asset.clone(),
                    message: error.to_string(),
                })?
        {
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            received += chunk.len() as u64;
            if received.saturating_sub(last_reported) >= PROGRESS_STEP_BYTES {
                last_reported = received;
                report_progress(
                    progress,
                    operation_id,
                    format!(
                        "Downloading {} {} ({} MiB)",
                        artifact.label,
                        artifact.version,
                        received / (1024 * 1024)
                    ),
                );
            }
        }
        file.flush().await?;
        drop(file);
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(artifact.sha256) {
            let _ = tokio::fs::remove_file(destination).await;
            return Err(LoopxRuntimeInstallError::ChecksumMismatch {
                asset: artifact.asset.clone(),
                expected: artifact.sha256.to_string(),
                actual,
            });
        }
        Ok(())
    }
}

fn artifact_for(
    kind: LoopxManagedRuntimeKind,
) -> Result<RuntimeArtifact, LoopxRuntimeInstallError> {
    match kind {
        LoopxManagedRuntimeKind::Node => node_artifact(),
        LoopxManagedRuntimeKind::Git => git_artifact(),
    }
}

fn node_artifact() -> Result<RuntimeArtifact, LoopxRuntimeInstallError> {
    let version = NODE_PINNED_VERSION;
    let (suffix, sha256): (&'static str, &'static str) = if cfg!(target_os = "windows") {
        if cfg!(target_arch = "x86_64") {
            (
                "win-x64.zip",
                "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
            )
        } else if cfg!(target_arch = "aarch64") {
            (
                "win-arm64.zip",
                "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
            )
        } else {
            return Err(unsupported("Node.js", "Windows"));
        }
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "x86_64") {
            (
                "darwin-x64.tar.gz",
                "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
            )
        } else if cfg!(target_arch = "aarch64") {
            (
                "darwin-arm64.tar.gz",
                "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
            )
        } else {
            return Err(unsupported("Node.js", "macOS"));
        }
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "x86_64") {
            (
                "linux-x64.tar.gz",
                "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
            )
        } else if cfg!(target_arch = "aarch64") {
            (
                "linux-arm64.tar.gz",
                "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
            )
        } else {
            return Err(unsupported("Node.js", "Linux"));
        }
    } else {
        return Err(unsupported("Node.js", std::env::consts::OS));
    };

    let asset = format!("node-v{version}-{suffix}");
    let archive = if asset.ends_with(".zip") {
        ArchiveKind::Zip
    } else {
        ArchiveKind::TarGz
    };
    let (binaries, unix_executable): (&'static [&'static str], Option<&'static str>) =
        if cfg!(target_os = "windows") {
            (&["node.exe"], None)
        } else {
            (&["bin/node"], Some("bin/node"))
        };
    Ok(RuntimeArtifact {
        kind: LoopxManagedRuntimeKind::Node,
        label: "Node.js",
        component: "node",
        version,
        asset: asset.clone(),
        sha256,
        url: format!("{NODE_DIST_BASE_URL}/v{version}/{asset}"),
        archive,
        binaries,
        unix_executable,
    })
}

fn git_artifact() -> Result<RuntimeArtifact, LoopxRuntimeInstallError> {
    if !cfg!(target_os = "windows") {
        // There is no first-party portable Git for macOS/Linux; those hosts
        // use the system package manager or the Xcode command line tools.
        return Err(LoopxRuntimeInstallError::UnsupportedPlatform {
            runtime: "Git",
            detail: "app-managed Git is only available on Windows; install Git with your package manager (or `xcode-select --install` on macOS)".to_string(),
        });
    }
    let (suffix, sha256): (&'static str, &'static str) = if cfg!(target_arch = "x86_64") {
        (
            "64-bit.zip",
            "56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e",
        )
    } else if cfg!(target_arch = "aarch64") {
        (
            "arm64.zip",
            "05843f9d6e60306c3ab886799e2c67200caab921571f10512df3493049179ddb",
        )
    } else {
        return Err(unsupported("Git", "Windows"));
    };
    let asset = format!("MinGit-{GIT_PINNED_VERSION}-{suffix}");
    Ok(RuntimeArtifact {
        kind: LoopxManagedRuntimeKind::Git,
        label: "Git",
        component: "git",
        version: GIT_PINNED_VERSION,
        asset: asset.clone(),
        sha256,
        url: format!("{GIT_RELEASE_BASE_URL}/{GIT_PINNED_RELEASE_TAG}/{asset}"),
        archive: ArchiveKind::Zip,
        binaries: &["cmd/git.exe"],
        unix_executable: None,
    })
}

fn unsupported(runtime: &'static str, platform: &str) -> LoopxRuntimeInstallError {
    LoopxRuntimeInstallError::UnsupportedPlatform {
        runtime,
        detail: format!("no pinned archive is published for {platform}"),
    }
}

fn extract_archive(
    archive_path: &Path,
    destination: &Path,
    kind: ArchiveKind,
) -> Result<(), LoopxRuntimeInstallError> {
    std::fs::create_dir_all(destination)?;
    let asset = archive_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| archive_path.display().to_string());
    match kind {
        ArchiveKind::Zip => {
            let file = std::fs::File::open(archive_path)?;
            let mut archive =
                zip::ZipArchive::new(file).map_err(|error| LoopxRuntimeInstallError::Extract {
                    asset: asset.clone(),
                    message: error.to_string(),
                })?;
            for index in 0..archive.len() {
                let mut entry =
                    archive
                        .by_index(index)
                        .map_err(|error| LoopxRuntimeInstallError::Extract {
                            asset: asset.clone(),
                            message: error.to_string(),
                        })?;
                let Some(relative) = entry.enclosed_name() else {
                    continue;
                };
                let output = destination.join(relative);
                if entry.is_dir() {
                    std::fs::create_dir_all(&output)?;
                    continue;
                }
                if let Some(parent) = output.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut target = std::fs::File::create(&output)?;
                std::io::copy(&mut entry, &mut target)?;
            }
        }
        ArchiveKind::TarGz => {
            let file = std::fs::File::open(archive_path)?;
            let decoder = flate2::read::GzDecoder::new(file);
            let mut archive = tar::Archive::new(decoder);
            archive.unpack(destination).map_err(|error| {
                LoopxRuntimeInstallError::Extract {
                    asset: asset.clone(),
                    message: error.to_string(),
                }
            })?;
        }
    }
    Ok(())
}

/// Node.js tarballs and zips wrap everything in a single version directory,
/// while `MinGit` unpacks its own tree at the archive root. Normalise both.
fn resolve_content_root(extracted: &Path) -> Result<PathBuf, LoopxRuntimeInstallError> {
    let mut entries = std::fs::read_dir(extracted)?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    if entries.len() == 1 {
        let only = entries.remove(0);
        let file_type = only.file_type()?;
        if file_type.is_dir() {
            return Ok(only.path());
        }
    }
    Ok(extracted.to_path_buf())
}

#[cfg(unix)]
fn ensure_unix_executable(path: &Path) -> Result<(), LoopxRuntimeInstallError> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn ensure_unix_executable(_path: &Path) -> Result<(), LoopxRuntimeInstallError> {
    Ok(())
}

/// Moves `source` to `target`, replacing any previous installation only after
/// the new tree is fully in place. A failed swap restores the backup.
fn activate_directory(source: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("invalid runtime target {}", target.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let backup = parent.join(format!(".backup-{}", uuid::Uuid::new_v4().simple()));
    let had_previous = target.exists();
    if had_previous {
        std::fs::rename(target, &backup).map_err(|error| {
            format!(
                "failed to move the previous runtime aside ({}): {error}",
                target.display()
            )
        })?;
    }
    if let Err(error) = std::fs::rename(source, target) {
        if had_previous {
            let _ = std::fs::rename(&backup, target);
        }
        return Err(format!(
            "failed to activate the new runtime at {}: {error}",
            target.display()
        ));
    }
    if had_previous {
        let _ = std::fs::remove_dir_all(&backup);
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn report_progress(progress: &dyn LoopxCliProgressSink, operation_id: &str, message: String) {
    progress.report(openbitfun_product_domains::miniapp::loopx::LoopxCliProgress {
        operation_id: operation_id.to_string(),
        task_id: None,
        stage: LoopxCliProgressStage::InstallingRuntime,
        message,
        occurred_at: now_ms(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_node_meets_the_loopx_control_plane_floor() {
        let mut parts = NODE_PINNED_VERSION.split('.');
        let major: u64 = parts.next().unwrap().parse().unwrap();
        let minor: u64 = parts.next().unwrap().parse().unwrap();
        assert!(
            (major, minor) >= (22, 6),
            "pinned Node.js {NODE_PINNED_VERSION} is below the LoopX floor"
        );
    }

    #[test]
    fn node_artifact_url_and_checksum_are_pinned() {
        let artifact = node_artifact().expect("node artifact on a supported host");
        assert_eq!(artifact.component, "node");
        assert!(artifact.url.starts_with("https://nodejs.org/dist/v"));
        assert!(artifact.url.ends_with(&artifact.asset));
        assert_eq!(artifact.sha256.len(), 64);
        assert!(artifact
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn resolve_content_root_unwraps_a_single_directory() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-runtime-content-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let inner = root.join("node-v24.21.0-win-x64");
        std::fs::create_dir_all(inner.join("bin")).unwrap();
        let resolved = resolve_content_root(&root).unwrap();
        assert_eq!(resolved, inner);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_content_root_keeps_a_split_tree() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-runtime-content-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(root.join("cmd")).unwrap();
        std::fs::create_dir_all(root.join("mingw64")).unwrap();
        let resolved = resolve_content_root(&root).unwrap();
        assert_eq!(resolved, root);
        let _ = std::fs::remove_dir_all(&resolved);
    }

    #[test]
    fn activate_directory_preserves_a_previous_install_on_failure() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-runtime-activate-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let target = root.join("current");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("marker"), b"old").unwrap();

        // A source that does not exist makes the swap fail and must restore the
        // previous `current` tree instead of leaving the component empty.
        let error = activate_directory(&root.join("missing"), &target).unwrap_err();
        assert!(error.contains("failed to activate"));
        assert!(target.join("marker").is_file());

        let _ = std::fs::remove_dir_all(&root);
    }
}
