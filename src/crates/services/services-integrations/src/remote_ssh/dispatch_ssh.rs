//! SSH transport for persistent OpenBitFun dispatch jobs.
//!
//! The target-side runner is the `openbitfun dispatch` CLI surface. This module is
//! deliberately only a controller transport: the remote CLI owns jobs,
//! workspaces, sessions, transcripts, process detachment, supervision, and
//! cancellation semantics.
//!
//! `probe` is read-only. Submission may automatically install the latest
//! compatible prebuilt release when the target is missing a compatible CLI;
//! `install_cli_start` still verifies the signed SHA256 sidecar and mandatory
//! archive minisign signature before staging an owner-only installer. Source
//! builds remain a separate, explicitly confirmed operation.

use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use openbitfun_services_core::dispatch_contract::{
    DispatchAccountDaemonIdentity, DispatchAccountDaemonProvisionRequest,
    DispatchAccountDaemonProvisionResponse, DISPATCH_ACCOUNT_DAEMON_PROVISIONING_CAPABILITY,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::future::Future;
use std::time::Duration;

use super::manager::SSHConnectionManager;
use super::product_paths::{
    product_data_path, product_data_relative_path, product_home_shell_path,
};
use super::release_verify::{
    parse_sha256, release_tag_for_version, require_release_pubkey, verify_minisign, verify_sha256,
    verify_signed_checksum,
};
use super::remote_git::shell_quote_posix;
use super::types::SSHCommandOptions;

const GITHUB_RELEASE_BASE: &str = "https://github.com/GCWing/OpenBitFun/releases";
const OPENBITFUN_RELEASE_BASE: &str = "https://openbitfun.com/release";
const GITHUB_LATEST_MANIFEST: &str =
    "https://github.com/GCWing/OpenBitFun/releases/latest/download/latest-v1.json";
const OPENBITFUN_LATEST_MANIFEST: &str = "https://openbitfun.com/release/latest-v1.json";
const INSTALL_STEM: &str = "install-cli";
const INSTALL_DONE_MARKER: &str = "OPENBITFUN_DISPATCH_CLI_INSTALL_DONE";
const INSTALL_PREPARE_GRACE_SECONDS: u64 = 30;
const COMMAND_TIMEOUT_MS: u64 = 30_000;
const ACCOUNT_DAEMON_COMMAND_TIMEOUT_MS: u64 = 90_000;
const WORKSPACE_OPERATION_WAIT: Duration = Duration::from_secs(30 * 60);
const WORKSPACE_OPERATION_POLL_INTERVAL: Duration = Duration::from_millis(750);
/// A release archive is tens of megabytes and the target's uplink is unknown,
/// so this is far longer than an ordinary setup command.
const TARGET_DOWNLOAD_TIMEOUT_MS: u64 = 10 * 60 * 1000;
const CLI_INSTALL_POLL_INTERVAL: Duration = Duration::from_millis(750);
/// A source-free release install is a download plus an unpack; anything past
/// this is a hung target rather than a slow one.
const CLI_INSTALL_WAIT: Duration = Duration::from_secs(15 * 60);
const RELEASE_READ_TIMEOUT_SECONDS: u64 = 30;
const RELEASE_PROBE_WINDOW: Duration = Duration::from_secs(10);
const RELEASE_PROBE_BYTES: u64 = 4 * 1024 * 1024;
const GITHUB_HEALTHY_THROUGHPUT: u64 = 512 * 1024;
const MAX_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
/// A result bundle carries only commits since the dispatch baseline, so it is
/// bounded well below a full repository clone in the usual case.
const MAX_RESULT_BUNDLE_BYTES: u64 = 1024 * 1024 * 1024;
const RESULT_BUNDLE_CHUNK_BYTES: u64 = 256 * 1024;
const MAX_RESULT_BUNDLE_CHUNK_BASE64_BYTES: usize = 384 * 1024;

struct UnverifiedResultBundle {
    path: std::path::PathBuf,
    verified: bool,
}

impl UnverifiedResultBundle {
    fn new(path: &std::path::Path) -> Self {
        Self {
            path: path.to_path_buf(),
            verified: false,
        }
    }

    fn retain(&mut self) {
        self.verified = true;
    }
}

impl Drop for UnverifiedResultBundle {
    fn drop(&mut self) {
        if !self.verified {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
/// Oldest glibc the published Linux binaries run against. Kept in step with
/// `scripts/ci/check-glibc-floor.sh`, which enforces it at release time.
const GLIBC_FLOOR: &str = "2.35";
const DISPATCH_PROTOCOL_VERSION: u64 =
    openbitfun_services_core::dispatch_contract::DISPATCH_PROTOCOL_VERSION as u64;
/// First stable release whose CLI is known to contain every capability below.
///
/// Development builds can require capabilities before their next stable
/// version is published. In that window `CARGO_PKG_VERSION` still names the
/// previous release, so comparing only the installed and controller version
/// strings is not a sound compatibility test.
const FIRST_COMPATIBLE_STABLE_DISPATCH_RELEASE: (u64, u64, u64) = (1, 0, 0);
/// Derived once from the shared contract: the unconditional target surface
/// plus the platform-conditional detached worker.
static REQUIRED_DISPATCH_CAPABILITIES: std::sync::LazyLock<Vec<&'static str>> =
    std::sync::LazyLock::new(|| {
        openbitfun_services_core::dispatch_contract::dispatch_required_target_capabilities()
            .collect()
    });

fn install_state_relative_dir() -> String {
    product_data_relative_path(&["dispatch", "install"])
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchCliRelease {
    pub version: String,
    pub target: String,
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchSshProbe {
    pub cli_installed: bool,
    pub cli_path: Option<String>,
    pub os: String,
    pub arch: String,
    pub install_supported: bool,
    pub install_error: Option<String>,
    pub protocol_error: Option<String>,
    pub release: Option<DispatchCliRelease>,
    pub protocol: Option<Value>,
    /// Present only when the published binaries cannot run here, so the UI can
    /// explain why instead of offering an install that would fail the same way.
    pub prebuilt_incompatible: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchInstallStart {
    /// Absolute path of the staged driver. The task has already been launched;
    /// this path is returned for diagnostics and must not be executed again.
    pub script_path: String,
    pub version: String,
    pub target: String,
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchInstallStatus {
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchInstallPoll {
    pub cursor: u64,
    pub output: String,
    pub status: DispatchInstallStatus,
}

#[derive(Debug)]
struct RemoteTarget {
    os: String,
    arch: String,
    home: String,
    cli_path: Option<String>,
    tar_available: bool,
    /// Fetcher the target can use to pull the release itself, if any.
    downloader: Option<RemoteDownloader>,
    /// Command the target can use to check a SHA256 digest, if any.
    digest_tool: Option<RemoteDigestTool>,
    /// C library family on Linux targets; `None` off Linux or when unknown.
    libc: Option<RemoteLibc>,
    /// glibc version, when the target reported one.
    libc_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteLibc {
    Glibc,
    Musl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteDownloader {
    Curl,
    Wget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteDigestTool {
    /// GNU coreutils, present on Linux.
    Sha256Sum,
    /// Perl-based, what macOS ships instead.
    Shasum,
}

#[derive(Debug)]
struct ResolvedRelease {
    public: DispatchCliRelease,
    filename: String,
    sources: Vec<ReleaseArtifactSource>,
    /// Whether `public.sha256` came from a minisign signature this machine
    /// verified, rather than from an unauthenticated sidecar.
    ///
    /// The target has no minisign and no trust root, so letting it fetch the
    /// archive itself is only safe when the digest we hand it is provably the
    /// publisher's. Without that proof the archive's own signature is the only
    /// protection, and only this machine can check it.
    checksum_signature_verified: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReleaseOrigin {
    GitHub,
    OpenBitFun,
}

#[derive(Debug, Clone)]
struct ReleaseArtifactSource {
    origin: ReleaseOrigin,
    url: String,
    checksum_url: String,
    checksum_signature_url: String,
    archive_signature_url: String,
}

#[derive(Debug, Deserialize)]
struct LatestReleaseManifest {
    version: String,
}

/// Probe the remote OS/architecture and, when present, the target CLI dispatch
/// protocol. A missing or old CLI is a normal result rather than an error.
///
/// Release metadata is resolved only when installation or upgrade is needed.
/// Resolving it verifies the signature over the SHA256 sidecar so the UI can
/// safely show the exact URL, version, and digest before asking for consent.
pub async fn probe(
    manager: &SSHConnectionManager,
    connection_id: &str,
    workspace_path: Option<&str>,
) -> Result<DispatchSshProbe> {
    ensure_plain_ssh_target(manager, connection_id).await?;
    let target = probe_remote_target(manager, connection_id).await?;

    let mut protocol = None;
    let mut protocol_error = None;
    if let Some(cli_path) = target.cli_path.as_deref() {
        let request = workspace_path
            .map(|path| serde_json::json!({ "workspacePath": path }))
            .unwrap_or_else(|| serde_json::json!({}));
        match invoke_json_at_path(
            manager,
            connection_id,
            &target.home,
            cli_path,
            "probe",
            &request,
        )
        .await
        {
            Ok(response) => {
                protocol_error = validate_dispatch_protocol(&response, None)
                    .err()
                    .map(|error| error.to_string());
                protocol = Some(response);
            }
            Err(error) => protocol_error = Some(error.to_string()),
        }
    }

    let needs_install = target.cli_path.is_none()
        || !protocol
            .as_ref()
            .is_some_and(dispatch_protocol_is_compatible);
    // A platform mismatch is decided before any network work: no release exists
    // that would install successfully, so resolving one only hides the reason.
    let incompatibility = needs_install
        .then(|| prebuilt_incompatibility(&target))
        .flatten();
    let (release, install_error) = if needs_install {
        if let Some(incompatibility) = &incompatibility {
            (None, Some(incompatibility.describe()))
        } else if !target.tar_available {
            (
                None,
                Some("remote target has no tar executable; install tar and retry".to_string()),
            )
        } else {
            match resolve_release(&target.os, &target.arch).await {
                // Capability support is a fact about the published artifact,
                // not about whether its semver happens to equal the installed
                // binary. A locally or previously source-built CLI may share a
                // version string with a different artifact.
                Ok(release)
                    if published_release_supports_required_dispatch_protocol(
                        &release.public.version,
                    ) =>
                {
                    (Some(release.public), None)
                }
                Ok(release) => (
                    None,
                    Some(format!(
                        "published OpenBitFun CLI {} does not carry the dispatch capabilities this controller requires",
                        release.public.version
                    )),
                ),
                Err(error) => (None, Some(error.to_string())),
            }
        }
    } else {
        (None, None)
    };
    let install_supported = release.is_some();

    Ok(DispatchSshProbe {
        cli_installed: target.cli_path.is_some(),
        cli_path: target.cli_path,
        os: target.os,
        arch: target.arch,
        install_supported,
        install_error,
        protocol_error,
        release,
        protocol,
        prebuilt_incompatible: incompatibility
            .as_ref()
            .map(PrebuiltIncompatibility::describe),
    })
}

/// Why the published binaries cannot run on this target.
///
/// Kept structured rather than a flat string so the UI can say what is actually
/// wrong instead of leaving the user with an unexplained failure.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PrebuiltIncompatibility {
    UnsupportedPlatform { os: String, arch: String },
    MuslLibc,
    GlibcTooOld { found: String },
}

impl PrebuiltIncompatibility {
    fn describe(&self) -> String {
        match self {
            Self::UnsupportedPlatform { os, arch } => format!(
                "OpenBitFun publishes no CLI binary for {os} {arch}"
            ),
            Self::MuslLibc => format!(
                "target uses musl libc; published binaries are linked against glibc {GLIBC_FLOOR} or newer"
            ),
            Self::GlibcTooOld { found } => format!(
                "target has glibc {found}; published binaries require {GLIBC_FLOOR} or newer"
            ),
        }
    }
}

/// Detect an incompatibility that no amount of reinstalling can fix.
fn prebuilt_incompatibility(target: &RemoteTarget) -> Option<PrebuiltIncompatibility> {
    if release_target(&target.os, &target.arch).is_err() {
        return Some(PrebuiltIncompatibility::UnsupportedPlatform {
            os: target.os.clone(),
            arch: target.arch.clone(),
        });
    }
    // Only Linux binaries carry a libc requirement; macOS builds do not.
    if !target.os.trim().eq_ignore_ascii_case("Linux") {
        return None;
    }
    match target.libc {
        Some(RemoteLibc::Musl) => Some(PrebuiltIncompatibility::MuslLibc),
        Some(RemoteLibc::Glibc) => {
            let found = target.libc_version.as_deref()?;
            (compare_versions(found, GLIBC_FLOOR) == std::cmp::Ordering::Less).then(|| {
                PrebuiltIncompatibility::GlibcTooOld {
                    found: found.to_string(),
                }
            })
        }
        None => None,
    }
}

/// Numeric dotted-version comparison. `2.9` must order below `2.35`, which a
/// lexicographic comparison would get backwards.
fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parse = |value: &str| {
        value
            .split('.')
            .map(|part| part.trim().parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let (left, right) = (parse(left), parse(right));
    for index in 0..left.len().max(right.len()) {
        let ordering = left
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&right.get(index).copied().unwrap_or(0));
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
    }
    std::cmp::Ordering::Equal
}

/// Whether a published artifact is expected to implement the controller's
/// required protocol.
///
/// OpenBitFun starts at 1.0.0. No OpenBitFun 0.x artifact is a compatible install
/// candidate, even if it was built from a checkout that happened to carry a
/// similar dispatch surface.
fn published_release_supports_required_dispatch_protocol(version: &str) -> bool {
    let Ok(parsed) = semver::Version::parse(version) else {
        return false;
    };
    parsed.pre.is_empty()
        && (parsed.major, parsed.minor, parsed.patch) >= FIRST_COMPATIBLE_STABLE_DISPATCH_RELEASE
}

fn dispatch_protocol_is_compatible(protocol: &Value) -> bool {
    validate_dispatch_protocol(protocol, None).is_ok()
}

/// Validate the target-side protocol immediately before submission.
///
/// `approval_policy = None` is used by installation probing and requires the
/// complete dispatch surface. Submission may validate only the selected
/// unattended approval behavior in addition to the transport invariants.
pub fn validate_dispatch_protocol(protocol: &Value, approval_policy: Option<&str>) -> Result<()> {
    let expected_product_id = openbitfun_services_core::product_identity::product_id();
    let product_id = protocol
        .get("productId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("dispatch target returned no productId"))?;
    if product_id != expected_product_id {
        return Err(anyhow!(
            "dispatch product is incompatible; expected {expected_product_id}, received {product_id}"
        ));
    }

    let expected_data_namespace = openbitfun_services_core::product_identity::data_namespace();
    let data_namespace = protocol
        .get("dataNamespace")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("dispatch target returned no dataNamespace"))?;
    if data_namespace != expected_data_namespace {
        return Err(anyhow!(
            "dispatch data namespace is incompatible; expected {expected_data_namespace}, received {data_namespace}"
        ));
    }

    if protocol.get("protocolVersion").and_then(Value::as_u64) != Some(DISPATCH_PROTOCOL_VERSION) {
        return Err(anyhow!(
            "dispatch protocol version is incompatible; expected {}",
            DISPATCH_PROTOCOL_VERSION
        ));
    }
    let Some(capabilities) = protocol.get("capabilities").and_then(Value::as_array) else {
        return Err(anyhow!("dispatch target returned no capability list"));
    };
    // One source list: submission narrows the approval_* entries to the
    // selected policy; probing (None) requires the complete surface.
    let mut required: Vec<&'static str> = REQUIRED_DISPATCH_CAPABILITIES
        .iter()
        .copied()
        .filter(|capability| !capability.starts_with("approval_"))
        .collect();
    match approval_policy {
        Some("auto") => required.push("approval_auto"),
        Some("reject-and-report") => required.push("approval_reject_and_report"),
        Some("remote") => required.push("approval_remote"),
        Some(_) => return Err(anyhow!("unsupported dispatch approval policy")),
        None => required.extend(
            REQUIRED_DISPATCH_CAPABILITIES
                .iter()
                .copied()
                .filter(|capability| capability.starts_with("approval_")),
        ),
    }
    let missing = required
        .iter()
        .copied()
        .filter(|required| {
            !capabilities
                .iter()
                .any(|capability| capability.as_str() == Some(*required))
        })
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(anyhow!(
            "dispatch target is missing required capabilities: {}",
            missing.join(", ")
        ));
    }
    Ok(())
}

/// Explicitly install the latest confirmed OpenBitFun CLI release on the SSH target.
///
/// This function fails closed when the build has no release trust root, a
/// checksum/signature is absent, or either verification fails. It never uses
/// sudo and writes only below `~/.local/bin` and `~/.openbitfun`.
pub async fn install_cli_start(
    manager: &SSHConnectionManager,
    connection_id: &str,
    expected_release: &DispatchCliRelease,
) -> Result<DispatchInstallStart> {
    ensure_plain_ssh_target(manager, connection_id).await?;
    let target = probe_remote_target(manager, connection_id).await?;
    if !target.tar_available {
        return Err(anyhow!(
            "remote target has no tar executable; install tar and retry"
        ));
    }
    let release = resolve_release(&target.os, &target.arch).await?;
    if !published_release_supports_required_dispatch_protocol(&release.public.version) {
        return Err(anyhow!(
            "published OpenBitFun CLI {} does not contain the dispatch capabilities required by this controller",
            release.public.version
        ));
    }
    ensure_confirmed_release(&release.public, expected_release)?;

    // Stop an earlier attempt before replacing any of its staged files. A
    // cancellation transport error is not safe to ignore: the old installer
    // may still be reading the archive or paths this attempt would replace.
    install_cli_cancel(manager, connection_id)
        .await
        .context("stop an earlier OpenBitFun CLI installation")?;

    let dir = product_data_path(&target.home, &["dispatch", "install"]);
    let archive_path = format!("{dir}/{}", release.filename);
    let body_path = format!("{dir}/{INSTALL_STEM}-body.sh");
    let script_path = format!("{dir}/{INSTALL_STEM}.sh");
    let install_token = format!(
        "{}-install-{}",
        openbitfun_services_core::product_identity::data_namespace(),
        uuid::Uuid::new_v4().as_simple()
    );

    exec_ok(
        manager,
        connection_id,
        &format!(
            "mkdir -p {dir} && chmod 700 {root} {dispatch} {dir}",
            root = shell_quote_posix(&product_data_path(&target.home, &[])),
            dispatch = shell_quote_posix(&product_data_path(&target.home, &["dispatch"])),
            dir = shell_quote_posix(&dir),
        ),
    )
    .await?;

    // Prefer letting the target pull the release straight from the publisher:
    // the controller's uplink is usually the slowest hop, and pushing tens of
    // megabytes through it is the worst available topology. Fall back to the
    // push path whenever that is not safely possible.
    let archive_source = match target_download_blocker(&target, &release) {
        Some(reason) => ArchiveSource::ControllerPush { reason },
        None => match download_archive_on_target(
            manager,
            connection_id,
            &target,
            &release,
            &archive_path,
        )
        .await
        {
            Ok(()) => ArchiveSource::TargetDownload,
            Err(error) => ArchiveSource::ControllerPush {
                reason: bounded_detail(&error.to_string()),
            },
        },
    };

    let body = to_unix_script(&install_body_script(
        &dir,
        &archive_path,
        &release.public.version,
        &archive_source,
    ));
    let driver = to_unix_script(&install_driver_script(&dir, &body_path, &install_token));
    if let ArchiveSource::ControllerPush { reason } = &archive_source {
        log::info!("OpenBitFun CLI dispatch install is pushing the archive over SFTP: {reason}");
        let archive = download_verified_archive(&release).await?;
        manager
            .sftp_write(connection_id, &archive_path, &archive)
            .await
            .context("stage verified OpenBitFun CLI archive")?;
    }
    stage_and_launch_installer(
        manager,
        connection_id,
        &dir,
        &archive_path,
        &body_path,
        &script_path,
        &body,
        &driver,
        &install_token,
    )
    .await?;

    Ok(DispatchInstallStart {
        script_path,
        version: release.public.version,
        target: release.public.target,
        url: release.public.url,
        sha256: release.public.sha256,
    })
}

/// How the verified archive reached the target.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ArchiveSource {
    /// The target fetched the release itself and checked it against a digest
    /// this machine proved with the publisher's signature.
    TargetDownload,
    /// This machine downloaded, fully verified, and pushed the bytes over SFTP.
    /// Carries why the target could not fetch it, for the install log.
    ControllerPush { reason: String },
}

/// Why this target cannot safely fetch the release itself, if it cannot.
///
/// The signature rule is the load-bearing one. A target has no minisign and no
/// trust root, so it can only check a plain SHA256. That is sound when the
/// digest is provably the publisher's, which is exactly what a verified
/// `.sha256.sig` gives us. When that signature is absent the digest is
/// unauthenticated, and the archive's own signature — checkable only here —
/// becomes the sole protection, so the bytes must flow through this machine.
fn target_download_blocker(target: &RemoteTarget, release: &ResolvedRelease) -> Option<String> {
    if !release.checksum_signature_verified {
        return Some("release checksum sidecar is unsigned".to_string());
    }
    if target.downloader.is_none() {
        return Some("target has neither curl nor wget".to_string());
    }
    if target.digest_tool.is_none() {
        return Some("target cannot verify a SHA256 digest".to_string());
    }
    None
}

/// Have the target fetch and digest-check the release into `archive_path`.
///
/// Synchronous on purpose: it replaces the SFTP upload, which was synchronous
/// too, so a dropped session is no worse than before and the detached installer
/// below still only ever sees a fully verified archive already on disk.
async fn download_archive_on_target(
    manager: &SSHConnectionManager,
    connection_id: &str,
    target: &RemoteTarget,
    release: &ResolvedRelease,
    archive_path: &str,
) -> Result<()> {
    let downloader = target
        .downloader
        .context("target download requires curl or wget")?;
    let digest_tool = target
        .digest_tool
        .context("target download requires a SHA256 checker")?;
    let github_url = release
        .sources
        .iter()
        .find(|source| source.origin == ReleaseOrigin::GitHub)
        .map(|source| source.url.as_str())
        .context("release has no GitHub source")?;
    let mirror_url = release
        .sources
        .iter()
        .find(|source| source.origin == ReleaseOrigin::OpenBitFun)
        .map(|source| source.url.as_str())
        .unwrap_or("");
    let script = target_download_script(
        downloader,
        digest_tool,
        archive_path,
        github_url,
        mirror_url,
        &release.public.sha256,
    );
    let result = manager
        .execute_command_with_options(
            connection_id,
            &script,
            SSHCommandOptions {
                timeout_ms: Some(TARGET_DOWNLOAD_TIMEOUT_MS),
                cancellation_token: None,
            },
        )
        .await?;
    ensure_command_completed(&result, "download OpenBitFun CLI release on the target")?;
    if result.exit_code != 0 {
        return Err(remote_command_error(
            "download OpenBitFun CLI release on the target",
            result.exit_code,
            &result.stdout,
            &result.stderr,
        ));
    }
    Ok(())
}

fn target_download_script(
    downloader: RemoteDownloader,
    digest_tool: RemoteDigestTool,
    archive_path: &str,
    github_url: &str,
    mirror_url: &str,
    sha256: &str,
) -> String {
    // Download to a scratch name and only publish it once the digest matches,
    // so a truncated or tampered body can never be handed to the installer.
    let fetch = match downloader {
        RemoteDownloader::Curl => format!(
            "curl -fsSL --retry 3 --retry-delay 1 --max-time {timeout} --max-filesize {max} -o \"$PART\" \"$URL\"",
            timeout = TARGET_DOWNLOAD_TIMEOUT_MS / 1000,
            max = MAX_ARCHIVE_BYTES,
        ),
        // wget has no --max-filesize; the size ceiling is enforced below.
        RemoteDownloader::Wget => format!(
            "wget -q --tries=3 --timeout={timeout} -O \"$PART\" \"$URL\"",
            timeout = TARGET_DOWNLOAD_TIMEOUT_MS / 1000,
        ),
    };
    let probe = match downloader {
        RemoteDownloader::Curl => format!(
            r#"METRICS=$(curl -LsS --range 0-{probe_end} --connect-timeout 5 --max-time {window} -o /dev/null -w '%{{http_code}} %{{size_download}} %{{time_total}}' "$GITHUB_URL" 2>/dev/null || true)
GITHUB_SPEED=$(printf '%s\n' "$METRICS" | awk '($1 == 200 || $1 == 206) && $3 > 0 {{ printf "%.0f\n", $2 / $3; ok=1 }} END {{ if (!ok) print 0 }}')"#,
            probe_end = RELEASE_PROBE_BYTES - 1,
            window = RELEASE_PROBE_WINDOW.as_secs(),
        ),
        RemoteDownloader::Wget => format!(
            r#"GITHUB_SPEED=0
PROBE="$ARCHIVE.probe"
if command -v timeout >/dev/null 2>&1; then
  rm -f "$PROBE"
  START=$(date +%s)
  timeout {window} wget -q --tries=1 --timeout={window} --header='Range: bytes=0-{probe_end}' -O "$PROBE" "$GITHUB_URL" || true
  END=$(date +%s)
  ELAPSED=$((END - START))
  [ "$ELAPSED" -gt 0 ] || ELAPSED=1
  if [ -f "$PROBE" ]; then
    BYTES=$(wc -c <"$PROBE" | tr -d '[:space:]')
  else
    BYTES=0
  fi
  GITHUB_SPEED=$((BYTES / ELAPSED))
  rm -f "$PROBE"
fi"#,
            probe_end = RELEASE_PROBE_BYTES - 1,
            window = RELEASE_PROBE_WINDOW.as_secs(),
        ),
    };
    let verify = match digest_tool {
        RemoteDigestTool::Sha256Sum => "sha256sum -c -",
        RemoteDigestTool::Shasum => "shasum -a 256 -c -",
    };
    format!(
        r#"set -eu
umask 077
ARCHIVE={archive}
PART="$ARCHIVE.part"
GITHUB_URL={github_url}
MIRROR_URL={mirror_url}
EXPECTED={sha}
MAX={max}
rm -f "$PART"
cleanup() {{ rm -f "$PART"; }}
trap cleanup EXIT
{probe}
case "$GITHUB_SPEED" in ''|*[!0-9]*) GITHUB_SPEED=0 ;; esac
FIRST_URL="$GITHUB_URL"
SECOND_URL="$MIRROR_URL"
if [ -n "$MIRROR_URL" ] && [ "$GITHUB_SPEED" -lt {healthy_bps} ]; then
  echo "GitHub CLI probe: $((GITHUB_SPEED / 1024)) KiB/s; trying OpenBitFun mirror first."
  FIRST_URL="$MIRROR_URL"
  SECOND_URL="$GITHUB_URL"
else
  echo "GitHub CLI probe: $((GITHUB_SPEED / 1024)) KiB/s; keeping GitHub first."
fi
INSTALLED=0
for URL in "$FIRST_URL" "$SECOND_URL"; do
  [ -n "$URL" ] || continue
  rm -f "$PART"
  echo "Downloading OpenBitFun CLI from $URL"
  if {fetch}; then
    SIZE=$(wc -c <"$PART" | tr -d '[:space:]')
    if [ "$SIZE" -le "$MAX" ] && printf '%s  %s\n' "$EXPECTED" "$PART" | {verify}; then
      mv -f "$PART" "$ARCHIVE"
      INSTALLED=1
      break
    fi
  fi
  echo "Download source failed verification; trying the next source." >&2
done
[ "$INSTALLED" = "1" ] || {{ echo "ERROR: every OpenBitFun CLI source failed" >&2; exit 1; }}
chmod 600 "$ARCHIVE"
trap - EXIT
"#,
        archive = shell_quote_posix(archive_path),
        github_url = shell_quote_posix(github_url),
        mirror_url = shell_quote_posix(mirror_url),
        sha = shell_quote_posix(sha256),
        max = MAX_ARCHIVE_BYTES,
        healthy_bps = GITHUB_HEALTHY_THROUGHPUT,
    )
}

/// Stage the installer scripts and launch the detached body.
///
/// Kept separate from `install_cli_start` so the token handshake, log
/// truncation, and channel-leak-free launch stay in one place.
#[allow(clippy::too_many_arguments)]
async fn stage_and_launch_installer(
    manager: &SSHConnectionManager,
    connection_id: &str,
    dir: &str,
    archive_path: &str,
    body_path: &str,
    script_path: &str,
    body: &str,
    driver: &str,
    install_token: &str,
) -> Result<()> {
    manager
        .sftp_write(connection_id, body_path, body.as_bytes())
        .await
        .context("stage OpenBitFun CLI install body")?;
    manager
        .sftp_write(connection_id, script_path, driver.as_bytes())
        .await
        .context("stage OpenBitFun CLI install driver")?;

    exec_ok(
        manager,
        connection_id,
        &stage_install_command(
            archive_path,
            body_path,
            script_path,
            &format!("{dir}/{INSTALL_STEM}.log"),
            &format!("{dir}/{INSTALL_STEM}.pid"),
            &format!("{dir}/{INSTALL_STEM}.driver.pid"),
            &format!("{dir}/{INSTALL_STEM}.preparing"),
            &format!("{dir}/{INSTALL_STEM}.exit"),
            install_token,
        ),
    )
    .await?;

    // The short-lived driver only starts a nohup body and exits, and it must run
    // without a PTY. sshd tears a PTY down as soon as the driver exits — about a
    // millisecond after the hand-off — and that teardown races the body it just
    // spawned. A body still inside bash's startup has not reached its own exit
    // trap yet, so losing that race kills it silently: no log, no exit file, and
    // a `.pid` the next poll then reaps as stale. The controller sees an empty
    // state and reports the install as failed even though nothing went wrong.
    // A plain exec channel has no controlling terminal, so the hand-off cannot be
    // interrupted; the installer needs no TTY semantics either, since it never
    // uses sudo. Draining the channel in the background prevents a server-side
    // channel leak while keeping the installer independent of the caller process.
    let channel = match manager
        .open_exec_channel(
            connection_id,
            &format!(
                "bash {} {}",
                shell_quote_posix(script_path),
                shell_quote_posix(install_token)
            ),
        )
        .await
    {
        Ok(channel) => channel,
        Err(error) => {
            let _ = install_cli_cancel(manager, connection_id).await;
            return Err(error).context("start remote OpenBitFun CLI installer");
        }
    };
    tokio::spawn(async move {
        let mut channel = channel;
        while channel.wait().await.is_some() {}
    });
    Ok(())
}

fn ensure_confirmed_release(
    resolved: &DispatchCliRelease,
    expected: &DispatchCliRelease,
) -> Result<()> {
    if resolved != expected {
        return Err(anyhow!(
            "OpenBitFun CLI release metadata changed after confirmation; probe the target and confirm the new asset"
        ));
    }
    Ok(())
}

pub async fn install_cli_poll(
    manager: &SSHConnectionManager,
    connection_id: &str,
    cursor: u64,
) -> Result<DispatchInstallPoll> {
    ensure_plain_ssh_target(manager, connection_id).await?;
    let script = install_poll_script(cursor);
    let result = manager
        .execute_command_with_options(
            connection_id,
            &script,
            SSHCommandOptions {
                timeout_ms: Some(COMMAND_TIMEOUT_MS),
                cancellation_token: None,
            },
        )
        .await?;
    ensure_command_completed(&result, "poll CLI install")?;
    if result.exit_code != 0 {
        return Err(remote_command_error(
            "poll CLI install",
            result.exit_code,
            &result.stdout,
            &result.stderr,
        ));
    }
    let (head, output) = split_metadata_output(&result.stdout);
    let value = |key: &str| {
        head.lines()
            .find_map(|line| {
                line.strip_prefix(key)
                    .and_then(|rest| rest.strip_prefix('='))
            })
            .unwrap_or("")
            .trim()
    };
    let running = value("running") == "1";
    let preparing = value("preparing") == "1";
    let marker = value("marker") == "1";
    let exit_recorded = value("exit_recorded") == "1";
    let exit_code = value("exit_code").parse::<i32>().ok();
    let size = value("size").parse::<u64>().unwrap_or(cursor);
    let status = if marker {
        DispatchInstallStatus::Succeeded
    } else if running || preparing {
        DispatchInstallStatus::Running
    } else if exit_recorded || size > 0 {
        DispatchInstallStatus::Failed
    } else {
        // start seeds the prepare flag before launching the driver, so an empty
        // state after an explicit start means the driver never became live.
        DispatchInstallStatus::Failed
    };
    let mut output = output.to_string();
    if status == DispatchInstallStatus::Failed && exit_code == Some(130) && output.is_empty() {
        output.push_str("OpenBitFun CLI installation was cancelled.\n");
    }
    Ok(DispatchInstallPoll {
        cursor: size,
        output,
        status,
    })
}

/// Best-effort process-tree cancellation for an in-flight CLI install.
pub async fn install_cli_cancel(manager: &SSHConnectionManager, connection_id: &str) -> Result<()> {
    ensure_plain_ssh_target(manager, connection_id).await?;
    let script = install_cancel_script();
    let result = manager
        .execute_command_with_options(
            connection_id,
            &script,
            SSHCommandOptions {
                timeout_ms: Some(COMMAND_TIMEOUT_MS),
                cancellation_token: None,
            },
        )
        .await?;
    ensure_command_completed(&result, "cancel CLI install")?;
    if result.exit_code != 0 {
        return Err(remote_command_error(
            "cancel CLI install",
            result.exit_code,
            &result.stdout,
            &result.stderr,
        ));
    }
    Ok(())
}

/// Read the SSH target's stable, non-secret device identity after verifying
/// that its CLI advertises the account-daemon bootstrap contract.
pub async fn account_daemon_identity(
    manager: &SSHConnectionManager,
    connection_id: &str,
) -> Result<DispatchAccountDaemonIdentity> {
    let cli_path = account_daemon_cli_path(manager, connection_id).await?;
    let command = format!(
        "{} daemon __dispatch_identity",
        shell_quote_posix(&cli_path)
    );
    let result = manager
        .execute_command_with_options(
            connection_id,
            &command,
            SSHCommandOptions {
                timeout_ms: Some(COMMAND_TIMEOUT_MS),
                cancellation_token: None,
            },
        )
        .await?;
    ensure_command_completed(&result, "read OpenBitFun daemon target identity")?;
    if result.exit_code != 0 {
        return Err(remote_command_error(
            "read OpenBitFun daemon target identity",
            result.exit_code,
            &result.stdout,
            &result.stderr,
        ));
    }
    let identity: DispatchAccountDaemonIdentity = serde_json::from_str(result.stdout.trim())
        .context("OpenBitFun daemon target returned an invalid identity")?;
    if identity.device_id.len() != 32
        || !identity
            .device_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        || identity.device_name.trim().is_empty()
        || identity.device_name.len() > 256
        || identity.device_name.chars().any(char::is_control)
    {
        return Err(anyhow!(
            "OpenBitFun daemon target returned an unsafe identity"
        ));
    }
    Ok(identity)
}

/// Stage one secret-bearing account bootstrap document, consume it through the
/// target CLI, and remove it regardless of command outcome.
pub async fn provision_account_daemon(
    manager: &SSHConnectionManager,
    connection_id: &str,
    request: &DispatchAccountDaemonProvisionRequest,
) -> Result<DispatchAccountDaemonProvisionResponse> {
    let cli_path = account_daemon_cli_path(manager, connection_id).await?;
    let target = probe_remote_target(manager, connection_id).await?;
    let request_dir = product_data_path(&target.home, &["dispatch", "requests"]);
    exec_ok(
        manager,
        connection_id,
        &format!(
            "mkdir -p {dir} && chmod 700 {root} {dispatch} {dir}",
            root = shell_quote_posix(&product_data_path(&target.home, &[])),
            dispatch = shell_quote_posix(&product_data_path(&target.home, &["dispatch"])),
            dir = shell_quote_posix(&request_dir),
        ),
    )
    .await?;
    let request_path = format!(
        "{request_dir}/daemon-provision-{}.json",
        uuid::Uuid::new_v4().as_simple()
    );
    let request_bytes =
        serde_json::to_vec(request).context("encode daemon provisioning request")?;
    exec_ok(
        manager,
        connection_id,
        &format!(
            "umask 077; : > {request}; chmod 600 {request}",
            request = shell_quote_posix(&request_path),
        ),
    )
    .await?;
    if let Err(error) = manager
        .sftp_write(connection_id, &request_path, &request_bytes)
        .await
        .context("stage daemon provisioning request")
    {
        let _ = manager.sftp_remove(connection_id, &request_path).await;
        return Err(error);
    }

    let command = format!(
        "request={request}; cleanup() {{ rm -f \"$request\"; }}; trap cleanup EXIT; \
         trap 'exit 130' HUP INT TERM; {cli} daemon __dispatch_provision \"$request\"",
        request = shell_quote_posix(&request_path),
        cli = shell_quote_posix(&cli_path),
    );
    let result = manager
        .execute_command_with_options(
            connection_id,
            &command,
            SSHCommandOptions {
                timeout_ms: Some(ACCOUNT_DAEMON_COMMAND_TIMEOUT_MS),
                cancellation_token: None,
            },
        )
        .await;
    let _ = manager.sftp_remove(connection_id, &request_path).await;
    let result = result?;
    ensure_command_completed(&result, "provision persistent OpenBitFun daemon")?;
    if result.exit_code != 0 {
        return Err(remote_command_error(
            "provision persistent OpenBitFun daemon",
            result.exit_code,
            &result.stdout,
            &result.stderr,
        ));
    }
    let response: DispatchAccountDaemonProvisionResponse =
        serde_json::from_str(result.stdout.trim())
            .context("OpenBitFun daemon provisioning returned invalid JSON")?;
    if response.device_id != request.device_id || !response.service_installed {
        return Err(anyhow!(
            "OpenBitFun daemon provisioning returned an inconsistent result"
        ));
    }
    Ok(response)
}

/// Best-effort rollback for a bootstrap whose relay-online verification did
/// not complete. The target command refuses to touch a different session.
pub async fn deprovision_account_daemon(
    manager: &SSHConnectionManager,
    connection_id: &str,
    device_id: &str,
    user_id: &str,
) -> Result<()> {
    let cli_path = account_daemon_cli_path(manager, connection_id).await?;
    let command = format!(
        "{} daemon __dispatch_deprovision {} {}",
        shell_quote_posix(&cli_path),
        shell_quote_posix(device_id),
        shell_quote_posix(user_id),
    );
    let result = manager
        .execute_command_with_options(
            connection_id,
            &command,
            SSHCommandOptions {
                timeout_ms: Some(ACCOUNT_DAEMON_COMMAND_TIMEOUT_MS),
                cancellation_token: None,
            },
        )
        .await?;
    ensure_command_completed(&result, "roll back OpenBitFun daemon provisioning")?;
    if result.exit_code != 0 {
        return Err(remote_command_error(
            "roll back OpenBitFun daemon provisioning",
            result.exit_code,
            &result.stdout,
            &result.stderr,
        ));
    }
    Ok(())
}

async fn account_daemon_cli_path(
    manager: &SSHConnectionManager,
    connection_id: &str,
) -> Result<String> {
    ensure_plain_ssh_target(manager, connection_id).await?;
    let probed = probe(manager, connection_id, None).await?;
    let protocol = probed
        .protocol
        .as_ref()
        .ok_or_else(|| anyhow!("the SSH target has no compatible OpenBitFun dispatch protocol"))?;
    validate_dispatch_protocol(protocol, None)?;
    let supports_provisioning = protocol
        .get("capabilities")
        .and_then(Value::as_array)
        .is_some_and(|capabilities| {
            capabilities.iter().any(|capability| {
                capability.as_str() == Some(DISPATCH_ACCOUNT_DAEMON_PROVISIONING_CAPABILITY)
            })
        });
    if !supports_provisioning {
        return Err(anyhow!(
            "the target OpenBitFun CLI does not support account daemon provisioning"
        ));
    }
    probed
        .cli_path
        .ok_or_else(|| anyhow!("the SSH target has no OpenBitFun CLI"))
}

/// Keys of the `ai` config section that make up "model configuration": the
/// model catalog (credentials included) plus every default-selection table the
/// target consults when resolving a ready model.
const MODEL_CONFIG_KEYS: [&str; 5] = [
    "models",
    "default_models",
    "agent_model_defaults",
    "agent_model_selections",
    "model_pools",
];

/// Write the controller's model configuration into the target's global config
/// so `openbitfun dispatch probe` can report a ready model.
///
/// `ai_model_config` is the snake_case `ai` slice restricted to
/// [`MODEL_CONFIG_KEYS`], exactly as `app.json` stores it. Everything else in
/// an existing target `app.json` is preserved; a target file that exists but
/// cannot be read or parsed aborts the sync instead of being overwritten. The
/// write is atomic (temp file + rename) and owner-only, because model entries
/// carry API credentials.
pub async fn sync_model_config(
    manager: &SSHConnectionManager,
    connection_id: &str,
    ai_model_config: &Value,
) -> Result<()> {
    let payload = validate_model_config_payload(ai_model_config)?;
    ensure_plain_ssh_target(manager, connection_id).await?;

    let locate = exec_lines(manager, connection_id, locate_target_config_script()).await?;
    let get = |key: &str| {
        locate
            .lines()
            .find_map(|line| {
                line.strip_prefix(key)
                    .and_then(|rest| rest.strip_prefix('='))
            })
            .unwrap_or("")
            .trim()
            .to_string()
    };
    if get("os") == "unsupported" {
        return Err(anyhow!(
            "model configuration sync supports only Linux and macOS SSH targets"
        ));
    }
    let config_dir = get("dir");
    if config_dir.is_empty() {
        return Err(anyhow!(
            "could not resolve the target OpenBitFun config directory"
        ));
    }
    let config_path = format!("{config_dir}/app.json");

    let existing = if get("config") == "1" {
        let bytes = manager
            .sftp_read(connection_id, &config_path)
            .await
            .context("read existing target app.json; refusing to overwrite it blindly")?;
        Some(String::from_utf8(bytes).context("target app.json is not UTF-8")?)
    } else {
        None
    };
    let merged = merge_model_config(existing.as_deref(), payload)?;

    exec_ok(
        manager,
        connection_id,
        &format!(
            "mkdir -p {dir} && chmod 700 \"$(dirname {dir})\" {dir}",
            dir = shell_quote_posix(&config_dir),
        ),
    )
    .await?;
    let data_namespace = openbitfun_services_core::product_identity::data_namespace();
    let staging_path = format!("{config_path}.{data_namespace}-sync.tmp");
    manager
        .sftp_write(connection_id, &staging_path, merged.as_bytes())
        .await
        .context("stage merged target app.json")?;
    exec_ok(
        manager,
        connection_id,
        &format!(
            "chmod 600 {staged} && mv -f {staged} {config}",
            staged = shell_quote_posix(&staging_path),
            config = shell_quote_posix(&config_path),
        ),
    )
    .await
}

fn validate_model_config_payload(
    ai_model_config: &Value,
) -> Result<&serde_json::Map<String, Value>> {
    let payload = ai_model_config
        .as_object()
        .ok_or_else(|| anyhow!("model configuration payload must be a JSON object"))?;
    if let Some(unexpected) = payload
        .keys()
        .find(|key| !MODEL_CONFIG_KEYS.contains(&key.as_str()))
    {
        return Err(anyhow!(
            "model configuration payload has unexpected key '{unexpected}'"
        ));
    }
    if payload
        .get("models")
        .and_then(Value::as_array)
        .is_none_or(|models| models.is_empty())
    {
        return Err(anyhow!(
            "the controller has no configured AI models to sync"
        ));
    }
    Ok(payload)
}

/// Graft the model-configuration keys onto an existing target config document,
/// leaving every other setting untouched.
fn merge_model_config(
    existing: Option<&str>,
    payload: &serde_json::Map<String, Value>,
) -> Result<String> {
    let mut root = match existing.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => serde_json::from_str::<Value>(text)
            .context("target app.json exists but is not valid JSON; refusing to overwrite it")?,
        None => Value::Object(serde_json::Map::new()),
    };
    let root_map = root
        .as_object_mut()
        .ok_or_else(|| anyhow!("target app.json is not a JSON object; refusing to overwrite it"))?;
    let ai = root_map
        .entry("ai")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let ai_map = ai.as_object_mut().ok_or_else(|| {
        anyhow!("target app.json has a non-object `ai` section; refusing to overwrite it")
    })?;
    for (key, value) in payload {
        ai_map.insert(key.clone(), value.clone());
    }
    serde_json::to_string_pretty(&root).context("encode merged target app.json")
}

/// Where the target CLI reads its global config from, mirroring the
/// `dirs::config_dir()` resolution inside the CLI itself.
fn locate_target_config_script() -> &'static str {
    r#"
LC_ALL=C
case "$(uname -s 2>/dev/null)" in
  Darwin) CONFIG_DIR="$HOME/Library/Application Support/openbitfun/config" ;;
  Linux) CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/openbitfun/config" ;;
  *) printf 'os=unsupported\n'; exit 0 ;;
esac
printf 'os=supported\n'
printf 'dir=%s\n' "$CONFIG_DIR"
if [ -f "$CONFIG_DIR/app.json" ]; then printf 'config=1\n'; else printf 'config=0\n'; fi
"#
}

async fn exec_lines(
    manager: &SSHConnectionManager,
    connection_id: &str,
    script: &str,
) -> Result<String> {
    let result = manager
        .execute_command_with_options(
            connection_id,
            script,
            SSHCommandOptions {
                timeout_ms: Some(COMMAND_TIMEOUT_MS),
                cancellation_token: None,
            },
        )
        .await?;
    ensure_command_completed(&result, "inspect SSH dispatch target")?;
    if result.exit_code != 0 {
        return Err(remote_command_error(
            "inspect SSH dispatch target",
            result.exit_code,
            &result.stdout,
            &result.stderr,
        ));
    }
    Ok(result.stdout)
}

pub async fn submit(
    manager: &SSHConnectionManager,
    connection_id: &str,
    request: &Value,
) -> Result<Value> {
    invoke_json(manager, connection_id, "submit", request).await
}

pub async fn status(
    manager: &SSHConnectionManager,
    connection_id: &str,
    request: &Value,
) -> Result<Value> {
    invoke_json(manager, connection_id, "status", request).await
}

pub async fn cancel(
    manager: &SSHConnectionManager,
    connection_id: &str,
    request: &Value,
) -> Result<Value> {
    invoke_json(manager, connection_id, "cancel", request).await
}

pub async fn list(
    manager: &SSHConnectionManager,
    connection_id: &str,
    request: &Value,
) -> Result<Value> {
    invoke_json(manager, connection_id, "list", request).await
}

pub async fn answer(
    manager: &SSHConnectionManager,
    connection_id: &str,
    request: &Value,
) -> Result<Value> {
    invoke_json(manager, connection_id, "answer", request).await
}

pub async fn append(
    manager: &SSHConnectionManager,
    connection_id: &str,
    request: &Value,
) -> Result<Value> {
    invoke_json(manager, connection_id, "append", request).await
}

/// Start the next turn of a dispatch session that has already finished one.
pub async fn continue_job(
    manager: &SSHConnectionManager,
    connection_id: &str,
    request: &Value,
) -> Result<Value> {
    invoke_json(manager, connection_id, "continue", request).await
}

pub async fn query(
    manager: &SSHConnectionManager,
    connection_id: &str,
    request: &Value,
) -> Result<Value> {
    invoke_json(manager, connection_id, "query", request).await
}

/// Commit the target's worktree and fetch the Git bundle it produced.
///
/// Downloads only. The controller decides separately whether to fast-forward
/// its baseline worktree onto the fetched branch, so nothing in the user's
/// repository moves as a side effect of asking.
pub async fn sync_workspace(
    manager: &SSHConnectionManager,
    connection_id: &str,
    job_id: &str,
    message: Option<&str>,
    known_head: Option<&str>,
    destination: &std::path::Path,
) -> Result<Value> {
    ensure_plain_ssh_target(manager, connection_id).await?;
    let target = probe_remote_target(manager, connection_id).await?;
    let cli_path = target.cli_path.as_deref().ok_or_else(|| {
        anyhow!("OpenBitFun CLI is not installed on the SSH target; install it before syncing")
    })?;

    // A clean incremental sync has `headCommit == knownHead`. Without an
    // invocation identity, the target cannot distinguish this call's poll
    // from a later click that intentionally checks for newer work, and would
    // restart the completed no-op forever.
    let mut request = serde_json::json!({
        "jobId": job_id,
        "operationId": uuid::Uuid::new_v4().as_simple().to_string(),
    });
    if let Some(message) = message.map(str::trim).filter(|value| !value.is_empty()) {
        request["message"] = Value::String(message.to_string());
    }
    if let Some(head) = known_head.map(str::trim).filter(|value| !value.is_empty()) {
        request["knownHead"] = Value::String(head.to_string());
    }
    let deadline = tokio::time::Instant::now() + WORKSPACE_OPERATION_WAIT;
    let response = loop {
        let response = invoke_json_at_path(
            manager,
            connection_id,
            &target.home,
            cli_path,
            "__workspace_sync",
            &request,
        )
        .await?;
        if response.get("pending").and_then(Value::as_bool) != Some(true) {
            break response;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!(
                "Git workspace sync did not finish within {} minutes",
                WORKSPACE_OPERATION_WAIT.as_secs() / 60
            ));
        }
        tokio::time::sleep(WORKSPACE_OPERATION_POLL_INTERVAL).await;
    };

    if response.get("changed").and_then(Value::as_bool) != Some(true) {
        return Ok(response);
    }

    let bundle_path = response
        .get("bundlePath")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("dispatch target returned no result bundle path"))?;
    // The path comes from the target, so bound it to the managed job directory
    // before reading it, exactly as the upload path is bounded.
    validate_managed_result_path(&target.home, job_id, bundle_path)?;
    let expected_size = response
        .get("bundleSize")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("dispatch target returned no result bundle size"))?;
    if expected_size == 0 || expected_size > MAX_RESULT_BUNDLE_BYTES {
        return Err(anyhow!(
            "dispatch result bundle exceeds the {} MB safety limit",
            MAX_RESULT_BUNDLE_BYTES / (1024 * 1024)
        ));
    }
    let expected_digest = response
        .get("bundleSha256")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("dispatch target returned no result bundle digest"))?;

    // The bundle carries repository history. The outbound root is already
    // owner-only, but harden this level too rather than relying on a parent.
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create result staging {}", parent.display()))?;
        harden_result_directory(parent)?;
    }
    let mut staged_bundle = UnverifiedResultBundle::new(destination);
    write_private_file(destination, &[])?;
    let mut output = std::fs::OpenOptions::new()
        .append(true)
        .open(destination)
        .with_context(|| format!("open result staging {}", destination.display()))?;
    let mut digest = Sha256::new();
    let mut received = 0_u64;
    while received < expected_size {
        let chunk = invoke_json_at_path(
            manager,
            connection_id,
            &target.home,
            cli_path,
            "__workspace_sync_chunk",
            &serde_json::json!({
                "jobId": job_id,
                "offset": received,
                "length": RESULT_BUNDLE_CHUNK_BYTES,
            }),
        )
        .await?;
        let encoded = chunk
            .get("dataBase64")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("dispatch target returned no result chunk data"))?;
        if encoded.len() > MAX_RESULT_BUNDLE_CHUNK_BASE64_BYTES {
            return Err(anyhow!(
                "dispatch target returned an oversized result chunk"
            ));
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .context("decode dispatch result chunk")?;
        if decoded.is_empty() || decoded.len() as u64 > RESULT_BUNDLE_CHUNK_BYTES {
            return Err(anyhow!(
                "dispatch result bundle ended at {received} of {expected_size} bytes"
            ));
        }
        let next_offset = received.saturating_add(decoded.len() as u64);
        if next_offset > expected_size {
            return Err(anyhow!(
                "dispatch target returned more result bytes than it declared"
            ));
        }
        if chunk.get("offset").and_then(Value::as_u64) != Some(next_offset) {
            return Err(anyhow!(
                "dispatch target returned a mismatched result chunk offset"
            ));
        }
        std::io::Write::write_all(&mut output, &decoded)
            .with_context(|| format!("write result staging {}", destination.display()))?;
        digest.update(&decoded);
        received = next_offset;
        let eof = chunk.get("eof").and_then(Value::as_bool) == Some(true);
        if eof != (received == expected_size) {
            return Err(anyhow!(
                "dispatch target returned an inconsistent result end marker"
            ));
        }
    }
    output
        .sync_all()
        .with_context(|| format!("flush result staging {}", destination.display()))?;
    let actual_digest = format!("{:x}", digest.finalize());
    if !actual_digest.eq_ignore_ascii_case(expected_digest) {
        return Err(anyhow!("dispatch result bundle SHA-256 mismatch"));
    }
    staged_bundle.retain();

    let mut response = response;
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "localBundlePath".to_string(),
            Value::String(destination.to_string_lossy().to_string()),
        );
    }
    Ok(response)
}

pub fn harden_result_directory(path: &std::path::Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("restrict result staging {}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Create owner-only before writing, so the contents are never briefly governed
/// by the process umask.
pub fn write_private_file(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("create {}", path.display()))?;
    std::io::Write::write_all(&mut file, bytes)
        .with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

/// A result bundle may only be read from the managed directory of the job it
/// belongs to.
fn validate_managed_result_path(home: &str, job_id: &str, bundle_path: &str) -> Result<()> {
    let expected = product_data_path(home, &["dispatch", "workspaces", job_id, "result.bundle"]);
    if bundle_path != expected {
        return Err(anyhow!(
            "dispatch target returned an unexpected result bundle path"
        ));
    }
    Ok(())
}

/// The upload path for a delivered base bundle, bounded to the job directory.
fn validate_managed_bundle_upload_path(home: &str, job_id: &str, upload_path: &str) -> Result<()> {
    let expected = product_data_path(home, &["dispatch", "workspaces", job_id, "incoming.bundle"]);
    if upload_path != expected {
        return Err(anyhow!(
            "dispatch target returned an invalid managed bundle upload path"
        ));
    }
    Ok(())
}

/// Ask the target to check out this dispatch's baseline commit.
///
/// Returns the target's raw response so the controller can react to
/// `needsBundle` — the target is the only side that knows what its own clone
/// can reach, so the decision to ship objects belongs to it, not to a guess
/// made from this machine's remote-tracking refs.
pub async fn provision_workspace(
    manager: &SSHConnectionManager,
    connection_id: &str,
    request: &Value,
) -> Result<Value> {
    invoke_workspace_operation(
        manager,
        connection_id,
        "__workspace_provision",
        request,
        "Git workspace provisioning",
    )
    .await
}

/// Poll an idempotent target verb whose expensive Git work runs in a detached
/// CLI child. Every SSH command returns quickly, so losing one channel cannot
/// kill clone/fetch/bundle work that the next poll can observe.
async fn invoke_workspace_operation(
    manager: &SSHConnectionManager,
    connection_id: &str,
    verb: &'static str,
    request: &Value,
    operation: &str,
) -> Result<Value> {
    ensure_plain_ssh_target(manager, connection_id).await?;
    let target = probe_remote_target(manager, connection_id).await?;
    let cli_path = target.cli_path.as_deref().ok_or_else(|| {
        anyhow!("OpenBitFun CLI is not installed on the SSH target; install it before dispatching")
    })?;
    let deadline = tokio::time::Instant::now() + WORKSPACE_OPERATION_WAIT;
    loop {
        let response = invoke_json_at_path(
            manager,
            connection_id,
            &target.home,
            cli_path,
            verb,
            request,
        )
        .await?;
        if response.get("pending").and_then(Value::as_bool) != Some(true) {
            return Ok(response);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!(
                "{operation} did not finish within {} minutes",
                WORKSPACE_OPERATION_WAIT.as_secs() / 60
            ));
        }
        tokio::time::sleep(WORKSPACE_OPERATION_POLL_INTERVAL).await;
    }
}

/// Upload a Git bundle carrying the objects the target reported missing.
///
/// The target CLI chooses the owner-only upload path. This adapter validates
/// that the returned path stays under the target's managed dispatch root before
/// allowing SFTP to write it.
pub async fn upload_bundle(
    manager: &SSHConnectionManager,
    connection_id: &str,
    job_id: &str,
    sha256: &str,
    size: u64,
    bundle_path: &std::path::Path,
) -> Result<Value> {
    ensure_plain_ssh_target(manager, connection_id).await?;
    let target = probe_remote_target(manager, connection_id).await?;
    let cli_path = target.cli_path.as_deref().ok_or_else(|| {
        anyhow!("OpenBitFun CLI is not installed on the SSH target; install it before dispatching")
    })?;

    let begin = invoke_json_at_path(
        manager,
        connection_id,
        &target.home,
        cli_path,
        "__workspace_bundle_begin",
        &serde_json::json!({
            "protocolVersion": DISPATCH_PROTOCOL_VERSION,
            "jobId": job_id,
            "sha256": sha256,
            "size": size,
        }),
    )
    .await?;
    if begin
        .get("committed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(begin);
    }
    if begin.get("accepted").and_then(Value::as_bool) != Some(true) {
        return Err(anyhow!("dispatch target did not accept the bundle upload"));
    }

    let upload_path = product_data_path(
        &target.home,
        &["dispatch", "workspaces", job_id, "incoming.bundle"],
    );
    validate_managed_bundle_upload_path(&target.home, job_id, &upload_path)?;
    let local_size = std::fs::symlink_metadata(bundle_path)
        .with_context(|| format!("inspect dispatch bundle {}", bundle_path.display()))?
        .len();
    if local_size != size {
        return Err(anyhow!(
            "dispatch bundle changed before SSH upload: expected {size} bytes, found {local_size}"
        ));
    }
    let retained_offset = begin
        .get("offset")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("dispatch target returned no bundle upload offset"))?;
    if retained_offset > size {
        return Err(anyhow!(
            "dispatch target returned an invalid bundle upload offset"
        ));
    }
    if retained_offset < size {
        let written = manager
            .sftp_write_from_file(connection_id, &upload_path, bundle_path, size)
            .await
            .context("upload dispatch bundle over SFTP")?;
        if written != size {
            return Err(anyhow!(
                "dispatch bundle SFTP upload ended at {written} of {size} bytes"
            ));
        }
    }

    let commit_request = serde_json::json!({ "jobId": job_id });
    let deadline = tokio::time::Instant::now() + WORKSPACE_OPERATION_WAIT;
    loop {
        let response = invoke_json_at_path(
            manager,
            connection_id,
            &target.home,
            cli_path,
            "__workspace_bundle_commit",
            &commit_request,
        )
        .await?;
        if response.get("pending").and_then(Value::as_bool) != Some(true) {
            if response.get("committed").and_then(Value::as_bool) == Some(true) {
                return Ok(response);
            }
            return Err(anyhow!(
                "dispatch target did not commit the delivered bundle"
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!(
                "Git bundle import did not finish within {} minutes",
                WORKSPACE_OPERATION_WAIT.as_secs() / 60
            ));
        }
        tokio::time::sleep(WORKSPACE_OPERATION_POLL_INTERVAL).await;
    }
}

/// Make sure the target runs a CLI this controller can dispatch to.
///
/// Installing is automatic because a dispatch is useless without it and the
/// user already authorized this SSH connection. What the confirmation dialog
/// used to guarantee is preserved by other means: the archive is still verified
/// against a signed SHA-256 and a mandatory minisign signature before it is
/// staged, and every step is reported through `progress` so the install is
/// visible in the dispatch session rather than silent.
///
/// Source builds are deliberately not automatic. They upload the user's own
/// repository and compile it on the target, which is a different kind of act
/// from fetching a signed release.
pub async fn ensure_target_cli<Progress, ProgressFuture>(
    manager: &SSHConnectionManager,
    connection_id: &str,
    mut progress: Progress,
) -> Result<DispatchSshProbe>
where
    Progress: FnMut(&str, Value) -> ProgressFuture,
    ProgressFuture: Future<Output = Result<()>>,
{
    let probed = probe(manager, connection_id, None).await?;
    if let Some(protocol) = probed.protocol.as_ref() {
        if validate_dispatch_protocol(protocol, None).is_ok() {
            return Ok(probed);
        }
    }
    if !probed.install_supported {
        return Err(anyhow!(
            "{}",
            probed
                .install_error
                .as_deref()
                .or(probed.protocol_error.as_deref())
                .unwrap_or("this SSH target cannot run the OpenBitFun CLI")
        ));
    }
    if let Some(reason) = probed.prebuilt_incompatible.as_deref() {
        return Err(anyhow!(
            "no published OpenBitFun CLI can run on this target ({reason}); install OpenBitFun there manually and retry"
        ));
    }
    let release = probed.release.clone().ok_or_else(|| {
        anyhow!("could not resolve an OpenBitFun CLI release for this target's platform")
    })?;

    progress(
        "cli-install-started",
        serde_json::json!({
            "version": release.version,
            "target": release.target,
            "url": release.url,
            "sha256": release.sha256,
            "reason": probed
                .protocol_error
                .clone()
                .unwrap_or_else(|| "the target has no compatible OpenBitFun CLI".to_string()),
        }),
    )
    .await
    .context("persist the CLI install started audit event")?;
    if let Err(error) = install_cli_start(manager, connection_id, &release).await {
        emit_cli_install_failure(&mut progress, "install-start", &error).await?;
        return Err(error);
    }

    let deadline = tokio::time::Instant::now() + CLI_INSTALL_WAIT;
    let mut cursor = 0_u64;
    loop {
        let poll = match install_cli_poll(manager, connection_id, cursor).await {
            Ok(poll) => poll,
            Err(error) => {
                emit_cli_install_failure(&mut progress, "install-poll", &error).await?;
                return Err(error);
            }
        };
        cursor = poll.cursor;
        match poll.status {
            DispatchInstallStatus::Succeeded => break,
            DispatchInstallStatus::Failed => {
                let error = anyhow!(
                    "OpenBitFun CLI installation failed on the SSH target: {}",
                    bounded_detail(&poll.output)
                );
                emit_cli_install_failure(&mut progress, "install-status", &error).await?;
                return Err(error);
            }
            _ => {}
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = install_cli_cancel(manager, connection_id).await;
            let error = anyhow!(
                "OpenBitFun CLI installation did not finish within {} minutes",
                CLI_INSTALL_WAIT.as_secs() / 60
            );
            emit_cli_install_failure(&mut progress, "install-timeout", &error).await?;
            return Err(error);
        }
        tokio::time::sleep(CLI_INSTALL_POLL_INTERVAL).await;
    }

    let reprobed = match probe(manager, connection_id, None).await {
        Ok(probed) => probed,
        Err(error) => {
            emit_cli_install_failure(&mut progress, "reprobe", &error).await?;
            return Err(error);
        }
    };
    let protocol = match reprobed.protocol.as_ref() {
        Some(protocol) => protocol,
        None => {
            let error = anyhow!(
                "{}",
                reprobed.protocol_error.as_deref().unwrap_or(
                    "the installed OpenBitFun CLI still does not answer the dispatch protocol"
                )
            );
            emit_cli_install_failure(&mut progress, "protocol-validation", &error).await?;
            return Err(error);
        }
    };
    // Fail closed: an install that "succeeded" but left an incompatible binary
    // must not be treated as a usable target.
    if let Err(error) = validate_dispatch_protocol(protocol, None) {
        emit_cli_install_failure(&mut progress, "protocol-validation", &error).await?;
        return Err(error);
    }
    progress(
        "cli-install-succeeded",
        serde_json::json!({
            "version": release.version,
            "cliPath": reprobed.cli_path,
        }),
    )
    .await
    .context("persist the CLI install succeeded audit event")?;
    Ok(reprobed)
}

async fn emit_cli_install_failure<Progress, ProgressFuture>(
    progress: &mut Progress,
    phase: &str,
    error: &anyhow::Error,
) -> Result<()>
where
    Progress: FnMut(&str, Value) -> ProgressFuture,
    ProgressFuture: Future<Output = Result<()>>,
{
    progress(
        "cli-install-failed",
        cli_install_failure_details(phase, &error.to_string()),
    )
    .await
    .map_err(|audit_error| {
        anyhow!(
            "persist the CLI install failed audit event for phase '{}': {}; original failure: {}",
            bounded_detail(phase),
            bounded_detail(&audit_error.to_string()),
            bounded_detail(&error.to_string())
        )
    })
}

fn cli_install_failure_details(phase: &str, error: &str) -> Value {
    let error = bounded_detail(error);
    serde_json::json!({
        "phase": bounded_detail(phase),
        "error": error,
        // Keep the existing audit/UI projection useful while `phase` and
        // `error` provide the structured durable form.
        "output": error,
    })
}

async fn invoke_json(
    manager: &SSHConnectionManager,
    connection_id: &str,
    verb: &'static str,
    request: &Value,
) -> Result<Value> {
    ensure_plain_ssh_target(manager, connection_id).await?;
    let target = probe_remote_target(manager, connection_id).await?;
    let cli_path = target.cli_path.as_deref().ok_or_else(|| {
        anyhow!("OpenBitFun CLI is not installed on the SSH target; confirm installation first")
    })?;
    invoke_json_at_path(
        manager,
        connection_id,
        &target.home,
        cli_path,
        verb,
        request,
    )
    .await
}

/// Transfer the request as an owner-only file instead of embedding its JSON in
/// the SSH command. Prompts can contain credentials or private source context;
/// command arguments would expose them to process listings and manager debug
/// previews on both machines.
async fn invoke_json_at_path(
    manager: &SSHConnectionManager,
    connection_id: &str,
    home: &str,
    cli_path: &str,
    verb: &'static str,
    request: &Value,
) -> Result<Value> {
    use openbitfun_core_types::agent_identity_wire::{
        translate_agent_identity_command, translate_agent_identity_response, AgentIdentityDialect,
    };
    let request =
        translate_agent_identity_command(verb, request.clone(), AgentIdentityDialect::Legacy)
            .map_err(anyhow::Error::msg)?;
    let request_dir = product_data_path(home, &["dispatch", "requests"]);
    exec_ok(
        manager,
        connection_id,
        &format!(
            "mkdir -p {dir} && chmod 700 {root} {dispatch} {dir}",
            root = shell_quote_posix(&product_data_path(home, &[])),
            dispatch = shell_quote_posix(&product_data_path(home, &["dispatch"])),
            dir = shell_quote_posix(&request_dir)
        ),
    )
    .await?;
    let request_path = format!("{request_dir}/{}.json", uuid::Uuid::new_v4().as_simple());
    let request_bytes = serde_json::to_vec(&request).context("serialize dispatch request")?;
    // Pre-create with 0600 before SFTP opens it. Creating first and chmodding
    // afterwards would leave a prompt briefly governed by the server's umask
    // (commonly 0644).
    exec_ok(
        manager,
        connection_id,
        &format!(
            "umask 077; : > {request}; chmod 600 {request}",
            request = shell_quote_posix(&request_path)
        ),
    )
    .await?;
    if let Err(error) = manager
        .sftp_write(connection_id, &request_path, &request_bytes)
        .await
        .context("stage dispatch request")
    {
        let _ = manager.sftp_remove(connection_id, &request_path).await;
        return Err(error);
    }

    let command = dispatch_command(cli_path, verb, &request_path);
    let result = manager
        .execute_command_with_options(
            connection_id,
            &command,
            SSHCommandOptions {
                timeout_ms: Some(COMMAND_TIMEOUT_MS),
                cancellation_token: None,
            },
        )
        .await;
    // The remote EXIT trap normally removes it. This covers channel-open and
    // transport failures before the shell installed that trap.
    let _ = manager.sftp_remove(connection_id, &request_path).await;
    let result = result?;
    ensure_command_completed(&result, &format!("dispatch {verb}"))?;
    if result.exit_code != 0 {
        return Err(remote_command_error(
            &format!("dispatch {verb}"),
            result.exit_code,
            &result.stdout,
            &result.stderr,
        ));
    }
    let response = serde_json::from_str(result.stdout.trim()).with_context(|| {
        format!(
            "dispatch {verb} returned invalid JSON: {}",
            bounded_detail(&result.stdout)
        )
    })?;
    translate_agent_identity_response(
        verb,
        response,
        &Value::Null,
        AgentIdentityDialect::Canonical,
    )
    .map_err(anyhow::Error::msg)
}

fn dispatch_command(cli_path: &str, verb: &str, request_path: &str) -> String {
    let cli = shell_quote_posix(cli_path);
    let request = shell_quote_posix(request_path);
    let verb = shell_quote_posix(verb);
    format!(
        "request={request}; \
         cleanup() {{ rm -f \"$request\"; }}; \
         trap cleanup EXIT; \
         trap 'exit 130' HUP INT TERM; \
         {cli} dispatch {verb} < \"$request\""
    )
}

async fn ensure_plain_ssh_target(
    manager: &SSHConnectionManager,
    connection_id: &str,
) -> Result<()> {
    let active_container = manager
        .get_connection_config(connection_id)
        .await
        .is_some_and(|config| config.container.is_some());
    let saved_container = manager
        .get_saved_connections()
        .await
        .into_iter()
        .find(|config| config.id == connection_id)
        .is_some_and(|config| config.container.is_some());
    if active_container || saved_container {
        return Err(anyhow!(
            "SSH dispatch does not support Docker-container connection targets"
        ));
    }
    Ok(())
}

async fn probe_remote_target(
    manager: &SSHConnectionManager,
    connection_id: &str,
) -> Result<RemoteTarget> {
    let script = probe_remote_target_script();
    let result = manager
        .execute_command_with_options(
            connection_id,
            script,
            SSHCommandOptions {
                timeout_ms: Some(COMMAND_TIMEOUT_MS),
                cancellation_token: None,
            },
        )
        .await?;
    ensure_command_completed(&result, "probe SSH dispatch target")?;
    if result.exit_code != 0 {
        return Err(remote_command_error(
            "probe SSH dispatch target",
            result.exit_code,
            &result.stdout,
            &result.stderr,
        ));
    }
    let get = |key: &str| {
        result
            .stdout
            .lines()
            .find_map(|line| {
                line.strip_prefix(key)
                    .and_then(|rest| rest.strip_prefix('='))
            })
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let home = get("home");
    if home.is_empty() {
        return Err(anyhow!("could not resolve remote $HOME"));
    }
    let cli_path = get("cli");
    Ok(RemoteTarget {
        os: get("os"),
        arch: get("arch"),
        home,
        cli_path: (!cli_path.is_empty()).then_some(cli_path),
        tar_available: get("tar") == "1",
        downloader: match get("downloader").as_str() {
            "curl" => Some(RemoteDownloader::Curl),
            "wget" => Some(RemoteDownloader::Wget),
            _ => None,
        },
        digest_tool: match get("digest").as_str() {
            "sha256sum" => Some(RemoteDigestTool::Sha256Sum),
            "shasum" => Some(RemoteDigestTool::Shasum),
            _ => None,
        },
        libc: match get("libc").as_str() {
            "glibc" => Some(RemoteLibc::Glibc),
            "musl" => Some(RemoteLibc::Musl),
            _ => None,
        },
        libc_version: (!get("libcversion").is_empty()).then(|| get("libcversion")),
    })
}

fn probe_remote_target_script() -> &'static str {
    r#"
LC_ALL=C
printf 'os=%s\n' "$(uname -s 2>/dev/null || true)"
printf 'arch=%s\n' "$(uname -m 2>/dev/null || true)"
printf 'home=%s\n' "$HOME"
if command -v tar >/dev/null 2>&1; then printf 'tar=1\n'; else printf 'tar=0\n'; fi
if command -v curl >/dev/null 2>&1; then printf 'downloader=curl\n'
elif command -v wget >/dev/null 2>&1; then printf 'downloader=wget\n'
else printf 'downloader=\n'; fi
if command -v sha256sum >/dev/null 2>&1; then printf 'digest=sha256sum\n'
elif command -v shasum >/dev/null 2>&1; then printf 'digest=shasum\n'
else printf 'digest=\n'; fi
if [ -x "$HOME/.local/bin/openbitfun" ]; then
  OPENBITFUN_BIN="$HOME/.local/bin/openbitfun"
else
  OPENBITFUN_BIN="$(command -v openbitfun 2>/dev/null || true)"
fi
printf 'cli=%s\n' "$OPENBITFUN_BIN"
if [ "$(uname -s 2>/dev/null || true)" = "Linux" ]; then
  if ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | head -n1 | grep -qi musl; then
    printf 'libc=musl\n'
  else
    printf 'libc=glibc\n'
    printf 'libcversion=%s\n' "$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $NF}' || true)"
  fi
fi
"#
}

async fn resolve_release(os: &str, arch: &str) -> Result<ResolvedRelease> {
    let pubkey = require_release_pubkey()?;
    let target = release_target(os, arch)?;
    let client = release_http_client()?;
    let version = fetch_latest_release_version(&client).await?;
    let filename = format!("openbitfun-cli-{version}-{target}.tar.gz");
    let sources = release_sources(&version, &filename);
    let (sha256, checksum_signature_verified) =
        resolve_release_digest(&client, &sources, pubkey, &filename).await?;
    let canonical_url = sources
        .iter()
        .find(|source| source.origin == ReleaseOrigin::GitHub)
        .map(|source| source.url.clone())
        .context("release has no canonical GitHub source")?;

    Ok(ResolvedRelease {
        public: DispatchCliRelease {
            version,
            target: target.to_string(),
            url: canonical_url,
            sha256,
        },
        filename,
        sources,
        checksum_signature_verified,
    })
}

fn release_sources(version: &str, filename: &str) -> Vec<ReleaseArtifactSource> {
    let tag = release_tag_for_version(version);
    [
        (
            ReleaseOrigin::GitHub,
            format!("{GITHUB_RELEASE_BASE}/download/{tag}"),
        ),
        (
            ReleaseOrigin::OpenBitFun,
            format!("{OPENBITFUN_RELEASE_BASE}/{version}"),
        ),
    ]
    .into_iter()
    .map(|(origin, base)| {
        let url = format!("{base}/{filename}");
        ReleaseArtifactSource {
            origin,
            checksum_url: format!("{url}.sha256"),
            checksum_signature_url: format!("{url}.sha256.sig"),
            archive_signature_url: format!("{url}.sig"),
            url,
        }
    })
    .collect()
}

async fn fetch_latest_release_version(client: &reqwest::Client) -> Result<String> {
    let mut failures = Vec::new();
    for manifest_url in [GITHUB_LATEST_MANIFEST, OPENBITFUN_LATEST_MANIFEST] {
        let text = match fetch_required_text(client, manifest_url).await {
            Ok(text) => text,
            Err(error) => {
                failures.push(format!("{manifest_url}: {error:#}"));
                continue;
            }
        };
        match latest_release_version_from_json(&text, manifest_url) {
            Ok(version) => return Ok(version),
            Err(error) => failures.push(format!("{manifest_url}: {error:#}")),
        }
    }
    Err(anyhow!(
        "could not resolve the latest OpenBitFun release: {}",
        failures.join("; ")
    ))
}

fn latest_release_version_from_json(text: &str, source: &str) -> Result<String> {
    let manifest: LatestReleaseManifest =
        serde_json::from_str(text).with_context(|| format!("parse {source}"))?;
    let version = manifest.version.trim();
    let parsed = semver::Version::parse(version)
        .with_context(|| format!("invalid release version {version}"))?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() {
        return Err(anyhow!(
            "latest release {version} is not a stable asset version"
        ));
    }
    Ok(version.to_string())
}

async fn resolve_release_digest(
    client: &reqwest::Client,
    sources: &[ReleaseArtifactSource],
    pubkey: &str,
    filename: &str,
) -> Result<(String, bool)> {
    let mut unsigned_digest = None;
    let mut failures = Vec::new();
    for source in sources {
        let checksum = match fetch_required_text(client, &source.checksum_url).await {
            Ok(checksum) => checksum,
            Err(error) => {
                failures.push(format!("{}: {error:#}", source.checksum_url));
                continue;
            }
        };
        match fetch_optional_text(client, &source.checksum_signature_url).await {
            Ok(Some(signature)) => {
                match verify_signed_checksum(&checksum, &signature, pubkey, filename) {
                    Ok(digest) => return Ok((digest, true)),
                    Err(error) => {
                        failures.push(format!("{}: {error:#}", source.checksum_signature_url))
                    }
                }
            }
            Ok(None) => match parse_sha256(&checksum, filename) {
                Ok(digest) => {
                    unsigned_digest.get_or_insert(digest);
                }
                Err(error) => failures.push(format!("{}: {error:#}", source.checksum_url)),
            },
            Err(error) => failures.push(format!("{}: {error:#}", source.checksum_signature_url)),
        }
    }
    if let Some(digest) = unsigned_digest {
        // Older releases have only an archive signature. They remain usable,
        // but must flow through the controller where minisign can be checked.
        return Ok((digest, false));
    }
    Err(anyhow!(
        "no release source published usable checksum metadata for {filename}: {}",
        failures.join("; ")
    ))
}

fn release_target(os: &str, arch: &str) -> Result<&'static str> {
    match (os.trim(), arch.trim()) {
        ("Linux", "x86_64" | "amd64") => Ok("x86_64-unknown-linux-gnu"),
        ("Linux", "aarch64" | "arm64") => Ok("aarch64-unknown-linux-gnu"),
        ("Darwin", "x86_64" | "amd64") => Ok("x86_64-apple-darwin"),
        ("Darwin", "aarch64" | "arm64") => Ok("aarch64-apple-darwin"),
        (os, arch) => Err(anyhow!(
            "OpenBitFun SSH dispatch CLI install does not support {os} {arch}"
        )),
    }
}

fn release_http_client() -> Result<reqwest::Client> {
    crate::reqwest_client_builder()
        .connect_timeout(Duration::from_secs(10))
        // Per-read rather than whole-request: a genuine slow link may take
        // longer than an arbitrary archive deadline, but a stalled source must
        // still fail instead of hanging the installer forever.
        .read_timeout(Duration::from_secs(RELEASE_READ_TIMEOUT_SECONDS))
        .build()
        .context("build OpenBitFun release HTTP client")
}

async fn fetch_required_text(client: &reqwest::Client, url: &str) -> Result<String> {
    client
        .get(url)
        .send()
        .await
        .with_context(|| format!("request {url}"))?
        .error_for_status()
        .with_context(|| format!("download {url}"))?
        .text()
        .await
        .with_context(|| format!("read {url}"))
}

/// Fetch a release sidecar that older releases legitimately do not have.
/// Only a definite 404 maps to `None`; any other failure stays an error so a
/// flaky network cannot silently downgrade verification.
async fn fetch_optional_text(client: &reqwest::Client, url: &str) -> Result<Option<String>> {
    let response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("request {url}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let text = response
        .error_for_status()
        .with_context(|| format!("download {url}"))?
        .text()
        .await
        .with_context(|| format!("read {url}"))?;
    Ok(Some(text))
}

async fn download_verified_archive(release: &ResolvedRelease) -> Result<Vec<u8>> {
    let pubkey = require_release_pubkey()?;
    let client = release_http_client()?;

    // Re-fetch and verify the signed sidecar at install time instead of trusting
    // a possibly stale preflight result.
    let (expected, _) =
        resolve_release_digest(&client, &release.sources, pubkey, &release.filename).await?;
    if !expected.eq_ignore_ascii_case(&release.public.sha256) {
        return Err(anyhow!(
            "release checksum changed after preflight; refusing to install"
        ));
    }

    let ordered = ordered_release_sources(&client, release).await;
    let mut failures = Vec::new();
    for source in &ordered {
        let archive = match download_release_bytes(&client, &source.url).await {
            Ok(archive) => archive,
            Err(error) => {
                failures.push(format!("{}: {error:#}", source.url));
                continue;
            }
        };
        if let Err(error) = verify_sha256(&archive, &expected, &release.filename) {
            failures.push(format!("{}: {error:#}", source.url));
            continue;
        }

        let mut signature_verified = false;
        for signature_source in std::iter::once(source).chain(
            ordered
                .iter()
                .filter(|candidate| candidate.url != source.url),
        ) {
            let signature =
                match fetch_required_text(&client, &signature_source.archive_signature_url).await {
                    Ok(signature) => signature,
                    Err(error) => {
                        failures.push(format!(
                            "{}: {error:#}",
                            signature_source.archive_signature_url
                        ));
                        continue;
                    }
                };
            match verify_minisign(&archive, &signature, pubkey) {
                Ok(()) => {
                    signature_verified = true;
                    break;
                }
                Err(error) => failures.push(format!(
                    "{}: {error:#}",
                    signature_source.archive_signature_url
                )),
            }
        }
        if signature_verified {
            return Ok(archive);
        }
    }

    Err(anyhow!(
        "OpenBitFun CLI archive failed from every source: {}",
        failures.join("; ")
    ))
}

async fn ordered_release_sources(
    client: &reqwest::Client,
    release: &ResolvedRelease,
) -> Vec<ReleaseArtifactSource> {
    let mut sources = release.sources.clone();
    let Some(github_index) = sources
        .iter()
        .position(|source| source.origin == ReleaseOrigin::GitHub)
    else {
        return sources;
    };
    let github_speed = probe_release_throughput(client, &sources[github_index].url).await;
    log::debug!(
        "Dispatch CLI GitHub probe: {} B/s from {}",
        github_speed,
        sources[github_index].url
    );
    order_release_sources_for_speed(&mut sources, github_speed);
    sources
}

fn order_release_sources_for_speed(sources: &mut [ReleaseArtifactSource], github_speed: u64) {
    let Some(github_index) = sources
        .iter()
        .position(|source| source.origin == ReleaseOrigin::GitHub)
    else {
        return;
    };
    if github_speed >= GITHUB_HEALTHY_THROUGHPUT
        || !sources
            .iter()
            .any(|source| source.origin == ReleaseOrigin::OpenBitFun)
    {
        sources.swap(0, github_index);
    } else if let Some(mirror_index) = sources
        .iter()
        .position(|source| source.origin == ReleaseOrigin::OpenBitFun)
    {
        sources.swap(0, mirror_index);
    }
}

async fn probe_release_throughput(client: &reqwest::Client, url: &str) -> u64 {
    let started = std::time::Instant::now();
    let request = client
        .get(url)
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", RELEASE_PROBE_BYTES - 1),
        )
        .send();
    let Ok(Ok(mut response)) = tokio::time::timeout(RELEASE_PROBE_WINDOW, request).await else {
        return 0;
    };
    if !response.status().is_success() {
        return 0;
    }
    let mut received = 0u64;
    loop {
        let Some(remaining) = RELEASE_PROBE_WINDOW.checked_sub(started.elapsed()) else {
            break;
        };
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, response.chunk()).await {
            Ok(Ok(Some(chunk))) => received += chunk.len() as u64,
            _ => break,
        }
        if received >= RELEASE_PROBE_BYTES {
            break;
        }
    }
    (received as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64
}

async fn download_release_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let mut response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("request {url}"))?
        .error_for_status()
        .with_context(|| format!("download {url}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_ARCHIVE_BYTES as u64)
    {
        return Err(anyhow!(
            "OpenBitFun CLI archive exceeds the {} MB safety limit",
            MAX_ARCHIVE_BYTES / (1024 * 1024)
        ));
    }
    let mut archive = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .with_context(|| format!("read {url}"))?
    {
        extend_bounded_archive(&mut archive, &chunk, MAX_ARCHIVE_BYTES)?;
    }
    Ok(archive)
}

fn extend_bounded_archive(archive: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<()> {
    if archive.len().saturating_add(chunk.len()) > limit {
        return Err(anyhow!(
            "OpenBitFun CLI archive exceeds the {} MB safety limit",
            limit / (1024 * 1024)
        ));
    }
    archive.extend_from_slice(chunk);
    Ok(())
}

/// State paths, single-binary staging, rollback, and the exit trap shared by
/// every signed release installation.
fn install_preamble_fragment(dir: &str, expected_version: &str) -> String {
    let product_home = product_home_shell_path(&[]);
    let hidden_data_directory = openbitfun_services_core::product_identity::hidden_data_directory();
    format!(
        r#"#!/bin/bash
set -euo pipefail
umask 077
D={dir}
EXPECTED_VERSION={version}
TOKEN="${{1:-}}"
PIDF="$D/{INSTALL_STEM}.pid"
EXITF="$D/{INSTALL_STEM}.exit"
TMP="$D/unpack.$$"
TARGET="$HOME/.local/bin/openbitfun"
# Stage under the final filename on the same filesystem as the target so the
# publish step is one atomic rename.
STAGE="$HOME/.local/bin/{hidden_data_directory}-dispatch-stage-$$"
NEW="$STAGE/openbitfun"
BACKUP="$D/previous-openbitfun.$$"
HAD_TARGET=0
TARGET_INSTALLED=0
COMMITTED=0
rollback_install() {{
  if [ "$TARGET_INSTALLED" = "1" ]; then rm -f "$TARGET"; fi
  if [ "$HAD_TARGET" = "1" ] && [ -f "$BACKUP" ]; then
    mv -f "$BACKUP" "$TARGET" \
      || echo "ERROR: could not restore previous openbitfun" >&2
  fi
}}
finish() {{
  code=$?
  trap - EXIT HUP INT TERM
  if [ "$code" -ne 0 ] && [ "$COMMITTED" != "1" ]; then rollback_install; fi
  rm -rf "$STAGE"
  if [ "$COMMITTED" = "1" ]; then rm -f "$BACKUP"; fi
  rm -rf "$TMP"
  printf '%s\n' "$code" >"$EXITF"
  marker_token="$(sed -n '2p' "$PIDF" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$TOKEN" ] && [ "$marker_token" = "$TOKEN" ]; then rm -f "$PIDF"; fi
  exit "$code"
}}
trap finish EXIT
trap 'exit 130' HUP INT TERM
rm -f "$EXITF"
mkdir -p "$TMP" "$STAGE" "$HOME/.local/bin" "{product_home}"
chmod 700 "{product_home}" "$STAGE"
"#,
        dir = shell_quote_posix(dir),
        version = shell_quote_posix(expected_version),
    )
}

/// Stage, smoke-test, and atomically commit the single `openbitfun` binary.
///
/// `post_commit` runs once the swap has succeeded, for path-specific cleanup.
fn install_commit_fragment(post_commit: &str) -> String {
    let product_id = openbitfun_services_core::product_identity::product_id();
    let data_namespace = openbitfun_services_core::product_identity::data_namespace();
    format!(
        r#"cp "$BINARY" "$NEW"
chmod 755 "$NEW"
staged="$("$NEW" --version 2>/dev/null || true)"
case "$staged" in
  *"$EXPECTED_VERSION"*) ;;
  *) echo "ERROR: staged CLI version did not match $EXPECTED_VERSION: $staged" >&2; exit 1 ;;
esac
# This installer exists only to serve dispatch, so a build without the
# subcommand is a failed install, not a successful one. Checking here — before
# anything is replaced — turns "install succeeded but the target is still
# reported incompatible" into one honest error at the point of cause.
if ! staged_dispatch="$("$NEW" dispatch --help 2>&1 >/dev/null)"; then
  echo "ERROR: this OpenBitFun build does not provide dispatch support: $staged_dispatch" >&2
  exit 1
fi
if ! staged_probe="$(printf '{{}}\n' | "$NEW" dispatch probe 2>/dev/null)"; then
  echo "ERROR: staged OpenBitFun dispatch probe failed" >&2
  exit 1
fi
case "$staged_probe" in
  *'"productId":"{product_id}",'*) ;;
  *) echo "ERROR: staged OpenBitFun CLI returned the wrong product identity" >&2; exit 1 ;;
esac
case "$staged_probe" in
  *'"dataNamespace":"{data_namespace}",'*) ;;
  *) echo "ERROR: staged OpenBitFun CLI returned the wrong data namespace" >&2; exit 1 ;;
esac
case "$staged_probe" in
  *'"protocolVersion":{protocol_version},'*) ;;
  *) echo "ERROR: staged OpenBitFun CLI returned an incompatible dispatch protocol" >&2; exit 1 ;;
esac
case "$staged_probe" in
  *'"{worker_profile_capability}"'*) ;;
  *) echo "ERROR: staged OpenBitFun CLI lacks safe dispatch worker profile selection" >&2; exit 1 ;;
esac
if [ -e "$TARGET" ]; then
  mv -f "$TARGET" "$BACKUP"
  HAD_TARGET=1
fi
mv -f "$NEW" "$TARGET"
TARGET_INSTALLED=1
installed="$("$TARGET" --version 2>/dev/null || true)"
case "$installed" in
  *"$EXPECTED_VERSION"*) ;;
  *) echo "ERROR: installed CLI version did not match $EXPECTED_VERSION: $installed" >&2; exit 1 ;;
esac
COMMITTED=1
{post_commit}
echo "Installed $installed at $HOME/.local/bin/openbitfun"
echo {INSTALL_DONE_MARKER}
"#,
        product_id = product_id,
        data_namespace = data_namespace,
        protocol_version = DISPATCH_PROTOCOL_VERSION,
        worker_profile_capability = "dispatch_worker_cli_profile",
    )
}

fn install_body_script(
    dir: &str,
    archive_path: &str,
    expected_version: &str,
    archive_source: &ArchiveSource,
) -> String {
    // Surfaced in the install output so the topology actually used is visible
    // rather than guessed at.
    let source_note = match archive_source {
        ArchiveSource::TargetDownload => {
            "Archive downloaded on the target and verified against the signed checksum.".to_string()
        }
        ArchiveSource::ControllerPush { reason } => {
            format!("Archive uploaded from this device ({reason}).")
        }
    };
    let extract = format!(
        r#"ARCHIVE={archive}
echo {source_note}
tar -xzf "$ARCHIVE" -C "$TMP"
BINARY=""
for candidate in "$TMP"/*/openbitfun; do
  [ -f "$candidate" ] || continue
  [ -z "$BINARY" ] || {{ echo "ERROR: archive contains multiple openbitfun binaries" >&2; exit 1; }}
  BINARY="$candidate"
done
for candidate in "$TMP"/*/openbitfun-cli; do
  [ ! -e "$candidate" ] || {{ echo "ERROR: archive contains an unsupported legacy CLI entrypoint" >&2; exit 1; }}
done
[ -n "$BINARY" ] || {{ echo "ERROR: archive contains no openbitfun binary" >&2; exit 1; }}
"#,
        archive = shell_quote_posix(archive_path),
        source_note = shell_quote_posix(&source_note),
    );
    format!(
        "{preamble}{extract}{commit}",
        preamble = install_preamble_fragment(dir, expected_version),
        commit = install_commit_fragment(r#"rm -f "$ARCHIVE""#),
    )
}

fn install_driver_script(dir: &str, body_path: &str, install_token: &str) -> String {
    format!(
        r#"#!/bin/bash
set -euo pipefail
umask 077
D={dir}
BODY={body}
EXPECTED_TOKEN={token}
TOKEN="${{1:-}}"
LOG="$D/{INSTALL_STEM}.log"
PIDF="$D/{INSTALL_STEM}.pid"
PIDF_TMP="$PIDF.$$"
DRIVER_PIDF="$D/{INSTALL_STEM}.driver.pid"
DRIVER_PIDF_TMP="$DRIVER_PIDF.$$"
PREPF="$D/{INSTALL_STEM}.preparing"
EXITF="$D/{INSTALL_STEM}.exit"
body_pid=
[ "$TOKEN" = "$EXPECTED_TOKEN" ] || exit 2
cleanup_prepare() {{
  if [ -n "$body_pid" ] && [ ! -f "$PIDF" ]; then
    kill "$body_pid" 2>/dev/null || true
  fi
  prepare_token="$(tr -d '[:space:]' < "$PREPF" 2>/dev/null || true)"
  if [ "$prepare_token" = "$TOKEN" ]; then rm -f "$PREPF"; fi
  driver_marker_token="$(sed -n '2p' "$DRIVER_PIDF" 2>/dev/null | tr -d '[:space:]')"
  if [ "$driver_marker_token" = "$TOKEN" ]; then rm -f "$DRIVER_PIDF"; fi
  rm -f "$PIDF_TMP" "$DRIVER_PIDF_TMP"
}}
cancel_prepare() {{ cleanup_prepare; exit 130; }}
trap cleanup_prepare EXIT
trap cancel_prepare HUP INT TERM
printf '%s\n%s\n' "$$" "$TOKEN" >"$DRIVER_PIDF_TMP"
mv -f "$DRIVER_PIDF_TMP" "$DRIVER_PIDF"
prepare_token="$(tr -d '[:space:]' < "$PREPF" 2>/dev/null || true)"
[ "$prepare_token" = "$TOKEN" ] || exit 130
rm -f "$PIDF" "$EXITF"
: >"$LOG"
prepare_token="$(tr -d '[:space:]' < "$PREPF" 2>/dev/null || true)"
[ "$prepare_token" = "$TOKEN" ] || exit 130
nohup bash "$BODY" "$TOKEN" >"$LOG" 2>&1 < /dev/null &
body_pid=$!
printf '%s\n%s\n' "$body_pid" "$TOKEN" >"$PIDF_TMP"
mv -f "$PIDF_TMP" "$PIDF"
body_pid=
rm -f "$PREPF" "$DRIVER_PIDF"
trap - EXIT HUP INT TERM
exit 0
"#,
        dir = shell_quote_posix(dir),
        body = shell_quote_posix(body_path),
        token = shell_quote_posix(install_token),
    )
}

#[allow(clippy::too_many_arguments)]
fn stage_install_command(
    archive_path: &str,
    body_path: &str,
    script_path: &str,
    log_path: &str,
    pid_path: &str,
    driver_pid_path: &str,
    prepare_path: &str,
    exit_path: &str,
    install_token: &str,
) -> String {
    format!(
        "chmod 600 {archive} && chmod 700 {body} {script} \
         && rm -f {pid} {driver_pid} {exit} \
         && : > {log} && chmod 600 {log} \
         && printf '%s\\n' {token} > {prepare} && chmod 600 {prepare}",
        archive = shell_quote_posix(archive_path),
        body = shell_quote_posix(body_path),
        script = shell_quote_posix(script_path),
        pid = shell_quote_posix(pid_path),
        driver_pid = shell_quote_posix(driver_pid_path),
        exit = shell_quote_posix(exit_path),
        log = shell_quote_posix(log_path),
        prepare = shell_quote_posix(prepare_path),
        token = shell_quote_posix(install_token),
    )
}

fn install_poll_script(cursor: u64) -> String {
    let install_state_dir = install_state_relative_dir();
    format!(
        r#"
D="$HOME/{install_state_dir}"
LOG="$D/{INSTALL_STEM}.log"
PIDF="$D/{INSTALL_STEM}.pid"
DRIVER_PIDF="$D/{INSTALL_STEM}.driver.pid"
PREPF="$D/{INSTALL_STEM}.preparing"
EXITF="$D/{INSTALL_STEM}.exit"
BODY="$D/{INSTALL_STEM}-body.sh"
DRIVER="$D/{INSTALL_STEM}.sh"
process_command() {{
  p="$1"
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$p" 2>/dev/null || return 1
  ps -ww -p "$p" -o command= 2>/dev/null
}}
installer_matches() {{
  p="$1"
  token="$2"
  [ -n "$token" ] || return 1
  command="$(process_command "$p")" || return 1
  case "$command" in
    *"$BODY"*"$token"*) return 0 ;;
    *) return 1 ;;
  esac
}}
driver_matches() {{
  p="$1"
  token="$2"
  [ -n "$token" ] || return 1
  command="$(process_command "$p")" || return 1
  case "$command" in
    *"$DRIVER"*"$token"*) return 0 ;;
    *) return 1 ;;
  esac
}}
running=0
if [ -f "$PIDF" ]; then
  pid="$(sed -n '1p' "$PIDF" | tr -d '[:space:]')"
  token="$(sed -n '2p' "$PIDF" | tr -d '[:space:]')"
  if installer_matches "$pid" "$token"; then
    running=1
  else
    rm -f "$PIDF"
  fi
fi
preparing=0
if [ -f "$PREPF" ]; then
  driver_live=0
  prepare_token="$(tr -d '[:space:]' < "$PREPF" 2>/dev/null || true)"
  if [ -f "$DRIVER_PIDF" ]; then
    driver_pid="$(sed -n '1p' "$DRIVER_PIDF" | tr -d '[:space:]')"
    driver_token="$(sed -n '2p' "$DRIVER_PIDF" | tr -d '[:space:]')"
    if [ "$driver_token" = "$prepare_token" ] && driver_matches "$driver_pid" "$driver_token"; then
      driver_live=1
    else
      rm -f "$DRIVER_PIDF"
    fi
  fi
  if [ "$driver_live" = "1" ]; then
    preparing=1
  else
    now="$(date +%s 2>/dev/null || true)"
    mtime="$(stat -c %Y "$PREPF" 2>/dev/null || stat -f %m "$PREPF" 2>/dev/null || true)"
    if [ -n "$now" ] && [ -n "$mtime" ] && [ $((now - mtime)) -lt {grace} ]; then
      preparing=1
    fi
  fi
fi
size=0
if [ -f "$LOG" ]; then size="$(wc -c < "$LOG" | tr -d ' ')"; fi
marker=0
if [ -f "$LOG" ] && grep -q {marker} "$LOG"; then marker=1; fi
exit_recorded=0
exit_code=
if [ -f "$EXITF" ]; then
  exit_recorded=1
  exit_code="$(tr -d '[:space:]' < "$EXITF")"
fi
printf 'running=%s\n' "$running"
printf 'preparing=%s\n' "$preparing"
printf 'size=%s\n' "$size"
printf 'marker=%s\n' "$marker"
printf 'exit_recorded=%s\n' "$exit_recorded"
printf 'exit_code=%s\n' "$exit_code"
printf '%s\n' '---'
from={from}
if [ "$from" -gt "$size" ]; then from=1; fi
if [ -f "$LOG" ]; then tail -c +"$from" "$LOG"; fi
"#,
        grace = INSTALL_PREPARE_GRACE_SECONDS,
        marker = shell_quote_posix(INSTALL_DONE_MARKER),
        from = cursor.saturating_add(1),
    )
}

fn install_cancel_script() -> String {
    let install_state_dir = install_state_relative_dir();
    format!(
        r#"
set +e
D="$HOME/{install_state_dir}"
LOG="$D/{INSTALL_STEM}.log"
PIDF="$D/{INSTALL_STEM}.pid"
DRIVER_PIDF="$D/{INSTALL_STEM}.driver.pid"
PREPF="$D/{INSTALL_STEM}.preparing"
EXITF="$D/{INSTALL_STEM}.exit"
BODY="$D/{INSTALL_STEM}-body.sh"
DRIVER="$D/{INSTALL_STEM}.sh"
active=0
[ -f "$PREPF" ] && active=1
# Invalidate a driver that has not reached its guarded spawn point yet.
rm -f "$PREPF"
installer_matches() {{
  p="$1"
  token="$2"
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  [ -n "$token" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  command="$(ps -ww -p "$p" -o command= 2>/dev/null)" || return 1
  case "$command" in
    *"$BODY"*"$token"*) return 0 ;;
    *) return 1 ;;
  esac
}}
driver_matches() {{
  p="$1"
  token="$2"
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  [ -n "$token" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  command="$(ps -ww -p "$p" -o command= 2>/dev/null)" || return 1
  case "$command" in
    *"$DRIVER"*"$token"*) return 0 ;;
    *) return 1 ;;
  esac
}}
kill_tree() {{
  p="$1"
  sig="$2"
  case "$p" in ''|*[!0-9]*) return 0 ;; esac
  for child in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$child" "$sig"; done
  kill "-$sig" "$p" 2>/dev/null || true
}}
if [ -f "$DRIVER_PIDF" ]; then
  driver_pid="$(sed -n '1p' "$DRIVER_PIDF" | tr -d '[:space:]')"
  driver_token="$(sed -n '2p' "$DRIVER_PIDF" | tr -d '[:space:]')"
  if driver_matches "$driver_pid" "$driver_token"; then
    active=1
    kill_tree "$driver_pid" TERM
    sleep 1
    if driver_matches "$driver_pid" "$driver_token"; then
      kill_tree "$driver_pid" KILL
    fi
  fi
fi
if [ -f "$PIDF" ]; then
  pid="$(sed -n '1p' "$PIDF" | tr -d '[:space:]')"
  token="$(sed -n '2p' "$PIDF" | tr -d '[:space:]')"
  if installer_matches "$pid" "$token"; then
    active=1
    kill_tree "$pid" TERM
    sleep 1
    if installer_matches "$pid" "$token"; then kill_tree "$pid" KILL; fi
  fi
fi
rm -f "$PIDF" "$DRIVER_PIDF" "$PREPF"
if [ "$active" = "1" ]; then
  printf '130\n' >"$EXITF"
  printf '\nOpenBitFun CLI installation cancelled by client.\n' >>"$LOG"
fi
exit 0
"#
    )
}

fn to_unix_script(script: &str) -> String {
    script.replace("\r\n", "\n")
}

fn split_metadata_output(stdout: &str) -> (&str, &str) {
    if let Some((head, output)) = stdout.split_once("---\r\n") {
        return (head, output);
    }
    if let Some((head, output)) = stdout.split_once("---\n") {
        return (head, output);
    }
    let mut offset = 0usize;
    for line in stdout.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return (&stdout[..offset], &stdout[offset + line.len()..]);
        }
        offset += line.len();
    }
    (stdout, "")
}

async fn exec_ok(manager: &SSHConnectionManager, connection_id: &str, command: &str) -> Result<()> {
    let result = manager
        .execute_command_with_options(
            connection_id,
            command,
            SSHCommandOptions {
                timeout_ms: Some(COMMAND_TIMEOUT_MS),
                cancellation_token: None,
            },
        )
        .await?;
    ensure_command_completed(&result, "remote setup")?;
    if result.exit_code != 0 {
        return Err(remote_command_error(
            "remote setup",
            result.exit_code,
            &result.stdout,
            &result.stderr,
        ));
    }
    Ok(())
}

fn ensure_command_completed(
    result: &super::types::SSHCommandResult,
    operation: &str,
) -> Result<()> {
    if result.timed_out {
        return Err(anyhow!("{operation} timed out"));
    }
    if result.interrupted {
        return Err(anyhow!("{operation} was cancelled"));
    }
    Ok(())
}

fn remote_command_error(
    operation: &str,
    exit_code: i32,
    stdout: &str,
    stderr: &str,
) -> anyhow::Error {
    let detail = if stderr.trim().is_empty() {
        bounded_detail(stdout)
    } else {
        bounded_detail(stderr)
    };
    anyhow!("{operation} failed (exit {exit_code}): {detail}")
}

fn bounded_detail(value: &str) -> String {
    value.trim().chars().take(500).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_install_scripts_are_lf_only_and_never_use_sudo() {
        let body = install_body_script(
            "/home/user/.openbitfun/dispatch/install",
            "/home/user/.openbitfun/dispatch/install/archive.tar.gz",
            "1.2.3",
            &ArchiveSource::TargetDownload,
        );
        let driver = install_driver_script(
            "/home/user/.openbitfun/dispatch/install",
            "/home/user/.openbitfun/dispatch/install/install-cli-body.sh",
            "openbitfun-install-test-token",
        );
        for (name, script) in [("body", body), ("driver", driver)] {
            let script = to_unix_script(&script);
            assert!(!script.contains('\r'), "{name} must be LF-only");
            assert!(
                !script.contains("sudo"),
                "{name} must never modify privileged paths"
            );
            assert!(!script.contains("/usr/"));
        }
    }

    fn test_release(checksum_signature_verified: bool) -> ResolvedRelease {
        let github_url = "https://github.example.invalid/openbitfun-cli.tar.gz";
        let mirror_url = "https://mirror.example.invalid/openbitfun-cli.tar.gz";
        ResolvedRelease {
            public: DispatchCliRelease {
                version: "1.2.3".to_string(),
                target: "x86_64-unknown-linux-gnu".to_string(),
                url: github_url.to_string(),
                sha256: "a".repeat(64),
            },
            filename: "openbitfun-cli.tar.gz".to_string(),
            sources: [
                (ReleaseOrigin::GitHub, github_url),
                (ReleaseOrigin::OpenBitFun, mirror_url),
            ]
            .into_iter()
            .map(|(origin, url)| ReleaseArtifactSource {
                origin,
                url: url.to_string(),
                checksum_url: format!("{url}.sha256"),
                checksum_signature_url: format!("{url}.sha256.sig"),
                archive_signature_url: format!("{url}.sig"),
            })
            .collect(),
            checksum_signature_verified,
        }
    }

    fn test_target(
        downloader: Option<RemoteDownloader>,
        digest_tool: Option<RemoteDigestTool>,
    ) -> RemoteTarget {
        RemoteTarget {
            os: "Linux".to_string(),
            arch: "x86_64".to_string(),
            home: "/home/user".to_string(),
            cli_path: None,
            tar_available: true,
            downloader,
            digest_tool,
            libc: Some(RemoteLibc::Glibc),
            libc_version: Some("2.39".to_string()),
        }
    }

    #[test]
    fn git_worktree_delivery_capabilities_are_required() {
        for capability in [
            "workspace_git_worktree",
            "workspace_git_bundle_upload",
            "workspace_git_sync",
        ] {
            assert!(
                REQUIRED_DISPATCH_CAPABILITIES.contains(&capability),
                "{capability} must fail closed because snapshot delivery no longer exists"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn staged_result_bundles_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let staging = temp.path().join(".results");
        std::fs::create_dir_all(&staging).expect("staging");
        // Simulate a permissive umask having created it.
        std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755)).expect("loosen");
        harden_result_directory(&staging).expect("harden");
        assert_eq!(
            std::fs::metadata(&staging)
                .expect("stat")
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "the staging directory holds user source and must not be world-readable"
        );

        let bundle = staging.join("job-1.tar.gz");
        write_private_file(&bundle, b"bundle bytes").expect("write");
        assert_eq!(
            std::fs::metadata(&bundle)
                .expect("stat")
                .permissions()
                .mode()
                & 0o777,
            0o600,
            "the bundle itself must be owner-only"
        );
        assert_eq!(std::fs::read(&bundle).expect("read"), b"bundle bytes");

        // Rewriting must not widen the mode or leave a stale tail.
        write_private_file(&bundle, b"short").expect("rewrite");
        assert_eq!(
            std::fs::metadata(&bundle)
                .expect("stat")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(std::fs::read(&bundle).expect("read"), b"short");
    }

    #[test]
    fn unverified_result_bundles_are_removed_but_verified_ones_are_retained() {
        let temp = tempfile::tempdir().expect("temp dir");
        let rejected = temp.path().join("rejected.bundle");
        std::fs::write(&rejected, b"tampered").expect("write rejected bundle");
        drop(UnverifiedResultBundle::new(&rejected));
        assert!(!rejected.exists());

        let accepted = temp.path().join("accepted.bundle");
        std::fs::write(&accepted, b"verified").expect("write accepted bundle");
        let mut guard = UnverifiedResultBundle::new(&accepted);
        guard.retain();
        drop(guard);
        assert_eq!(
            std::fs::read(&accepted).expect("read accepted"),
            b"verified"
        );
    }

    #[test]
    fn a_result_bundle_is_only_read_from_its_own_managed_directory() {
        // The path is chosen by the target, so a compromised or buggy one must
        // not be able to point this at an arbitrary file to exfiltrate.
        assert!(validate_managed_result_path(
            "/home/user",
            "job-1",
            "/home/user/.openbitfun/dispatch/workspaces/job-1/result.bundle"
        )
        .is_ok());
        for hostile in [
            "/home/user/.ssh/id_ed25519",
            "/home/user/.openbitfun/dispatch/workspaces/job-2/result.bundle",
            "/home/user/.openbitfun/dispatch/workspaces/job-1/../../../.ssh/id_ed25519",
            "/home/user/.openbitfun/dispatch/workspaces/job-1/current/secret",
        ] {
            assert!(
                validate_managed_result_path("/home/user", "job-1", hostile).is_err(),
                "must reject {hostile}"
            );
        }
    }

    #[test]
    fn glibc_versions_compare_numerically_not_lexicographically() {
        use std::cmp::Ordering;
        // The reason this needs its own function: as strings, "2.9" sorts above
        // "2.35", which would call a too-old host compatible.
        assert_eq!(compare_versions("2.9", "2.35"), Ordering::Less);
        assert_eq!(compare_versions("2.35", "2.35"), Ordering::Equal);
        assert_eq!(compare_versions("2.39", "2.35"), Ordering::Greater);
        assert_eq!(compare_versions("3.0", "2.35"), Ordering::Greater);
        assert_eq!(compare_versions("2.35.1", "2.35"), Ordering::Greater);
    }

    #[test]
    fn incompatible_targets_are_named_precisely() {
        let mut target = test_target(
            Some(RemoteDownloader::Curl),
            Some(RemoteDigestTool::Sha256Sum),
        );

        assert!(
            prebuilt_incompatibility(&target).is_none(),
            "a supported glibc host has no incompatibility"
        );

        target.libc = Some(RemoteLibc::Musl);
        assert_eq!(
            prebuilt_incompatibility(&target),
            Some(PrebuiltIncompatibility::MuslLibc)
        );

        target.libc = Some(RemoteLibc::Glibc);
        target.libc_version = Some("2.31".to_string());
        assert_eq!(
            prebuilt_incompatibility(&target),
            Some(PrebuiltIncompatibility::GlibcTooOld {
                found: "2.31".to_string()
            })
        );

        target.libc_version = Some("2.39".to_string());
        target.arch = "riscv64".to_string();
        assert!(matches!(
            prebuilt_incompatibility(&target),
            Some(PrebuiltIncompatibility::UnsupportedPlatform { .. })
        ));

        // macOS binaries carry no libc floor, so a musl reading must not leak in.
        let mut mac = test_target(None, None);
        mac.os = "Darwin".to_string();
        mac.arch = "arm64".to_string();
        mac.libc = Some(RemoteLibc::Musl);
        assert!(prebuilt_incompatibility(&mac).is_none());
    }

    #[test]
    fn the_install_path_uses_the_shared_staging_and_commit_implementation() {
        let release = install_body_script(
            "/home/user/.openbitfun/dispatch/install",
            "/home/user/.openbitfun/dispatch/install/archive.tar.gz",
            "1.2.3",
            &ArchiveSource::TargetDownload,
        );
        // Installing a signed release is the only way a target gets a CLI, so
        // its atomic-replace and rollback semantics must come from the shared
        // fragment rather than being restated inline.
        let commit = install_commit_fragment(r#"rm -f "$ARCHIVE""#);
        let shared = commit
            .lines()
            .find(|line| line.contains("mv -f \"$NEW\""))
            .expect("commit fragment swaps the binary");
        assert!(
            release.contains(shared),
            "release must use the shared commit"
        );
        assert!(
            release.contains(r#"NEW="$STAGE/openbitfun""#),
            "release must stage under the final filename"
        );
        assert!(
            release.contains("rollback_install"),
            "release must keep rollback"
        );
        assert!(
            release.contains("dispatch_worker_cli_profile"),
            "release must reject a CLI whose detached worker can select the wrong profile"
        );
        assert!(
            !release.contains("cargo build"),
            "no install path may compile OpenBitFun on the target"
        );
    }

    #[test]
    fn release_compatibility_uses_capability_floor_not_installed_version() {
        assert!(
            !published_release_supports_required_dispatch_protocol("0.2.15"),
            "OpenBitFun releases predate the OpenBitFun product contract"
        );
        assert!(
            !published_release_supports_required_dispatch_protocol("0.2.16"),
            "a previously compatible OpenBitFun release is not an OpenBitFun release"
        );
        assert!(!published_release_supports_required_dispatch_protocol(
            "0.3.0+build.1"
        ));
        assert!(!published_release_supports_required_dispatch_protocol(
            "1.0.0-nightly.1"
        ));
        assert!(published_release_supports_required_dispatch_protocol(
            "1.0.0"
        ));
        assert!(published_release_supports_required_dispatch_protocol(
            "1.0.1+build.1"
        ));
        assert!(!published_release_supports_required_dispatch_protocol(
            "not-a-version"
        ));
    }

    #[test]
    fn latest_release_manifest_accepts_only_stable_semver() {
        assert_eq!(
            latest_release_version_from_json(r#"{"version":"1.2.3"}"#, "fixture").unwrap(),
            "1.2.3"
        );
        assert!(
            latest_release_version_from_json(r#"{"version":"1.2.4-nightly.1"}"#, "fixture")
                .is_err()
        );
        assert!(latest_release_version_from_json(r#"{"version":"latest"}"#, "fixture").is_err());
    }

    #[test]
    fn latest_cli_sources_are_github_then_the_versioned_openbitfun_mirror() {
        let filename = "openbitfun-cli-1.2.3-x86_64-unknown-linux-gnu.tar.gz";
        let sources = release_sources("1.2.3", filename);
        assert_eq!(sources[0].origin, ReleaseOrigin::GitHub);
        assert_eq!(
            sources[0].url,
            format!("https://github.com/GCWing/OpenBitFun/releases/download/v1.2.3/{filename}")
        );
        assert_eq!(sources[1].origin, ReleaseOrigin::OpenBitFun);
        assert_eq!(
            sources[1].url,
            format!("https://openbitfun.com/release/1.2.3/{filename}")
        );
    }

    #[test]
    fn dispatch_cli_uses_the_mirror_only_below_the_github_speed_floor() {
        let mut slow = test_release(true).sources;
        order_release_sources_for_speed(&mut slow, GITHUB_HEALTHY_THROUGHPUT - 1);
        assert_eq!(slow[0].origin, ReleaseOrigin::OpenBitFun);

        let mut healthy = test_release(true).sources;
        healthy.swap(0, 1);
        order_release_sources_for_speed(&mut healthy, GITHUB_HEALTHY_THROUGHPUT);
        assert_eq!(healthy[0].origin, ReleaseOrigin::GitHub);
    }

    #[test]
    fn target_download_script_contains_the_same_speed_policy_and_both_sources() {
        let script = target_download_script(
            RemoteDownloader::Curl,
            RemoteDigestTool::Sha256Sum,
            "/tmp/openbitfun.tar.gz",
            "https://github.example/openbitfun.tar.gz",
            "https://mirror.example/openbitfun.tar.gz",
            &"a".repeat(64),
        );
        assert!(script.contains("524288"));
        assert!(script.contains("GITHUB_SPEED"));
        assert!(script.contains("https://github.example/openbitfun.tar.gz"));
        assert!(script.contains("https://mirror.example/openbitfun.tar.gz"));
    }

    #[test]
    fn an_unsigned_checksum_never_lets_the_target_fetch_the_release() {
        // The target can only check a plain digest. If that digest is not
        // provably the publisher's, the archive's own signature is the only
        // protection and only this machine can verify it.
        let capable = test_target(
            Some(RemoteDownloader::Curl),
            Some(RemoteDigestTool::Sha256Sum),
        );
        let blocker = target_download_blocker(&capable, &test_release(false));
        assert_eq!(
            blocker.as_deref(),
            Some("release checksum sidecar is unsigned"),
            "an unsigned sidecar must force the archive through this machine"
        );
        assert!(
            target_download_blocker(&capable, &test_release(true)).is_none(),
            "a signed sidecar on a capable target should download remotely"
        );
    }

    #[test]
    fn a_target_missing_its_tools_falls_back_to_the_push_path() {
        let signed = test_release(true);
        assert!(
            target_download_blocker(
                &test_target(None, Some(RemoteDigestTool::Sha256Sum)),
                &signed
            )
            .is_some(),
            "no curl or wget must fall back"
        );
        assert!(
            target_download_blocker(&test_target(Some(RemoteDownloader::Wget), None), &signed)
                .is_some(),
            "no digest checker must fall back"
        );
    }

    #[cfg(unix)]
    #[test]
    fn target_download_publishes_the_archive_only_when_the_digest_matches() {
        let available = |tool: &str| {
            std::process::Command::new(tool)
                .arg("--version")
                .output()
                .map(|out| out.status.success())
                .unwrap_or(false)
        };
        let Some((digest_command, digest_tool)) = [
            ("sha256sum", RemoteDigestTool::Sha256Sum),
            ("shasum -a 256", RemoteDigestTool::Shasum),
        ]
        .into_iter()
        .find(|(command, _)| available(command.split_whitespace().next().unwrap_or(command))) else {
            return; // no digest tool on this host
        };
        if !available("curl") {
            return; // no curl on this host
        }

        let temp = tempfile::tempdir().expect("temp dir");
        let source = temp.path().join("release.tar.gz");
        std::fs::write(&source, b"pretend release bytes").expect("write source");
        // Derive the expected digest with the same tool the script will use,
        // so this test needs no hashing dependency of its own.
        let digest_output = std::process::Command::new("bash")
            .args([
                "-c",
                &format!(
                    "{digest_command} {}",
                    shell_quote_posix(&source.to_string_lossy())
                ),
            ])
            .output()
            .expect("compute digest");
        assert!(digest_output.status.success(), "digest tool failed");
        let digest = String::from_utf8_lossy(&digest_output.stdout)
            .split_whitespace()
            .next()
            .expect("digest value")
            .to_string();
        let url = format!("file://{}", source.display());
        let archive = temp.path().join("staged.tar.gz");

        let run = |sha: &str| {
            let script = target_download_script(
                RemoteDownloader::Curl,
                digest_tool,
                &archive.to_string_lossy(),
                &url,
                "",
                sha,
            );
            std::process::Command::new("bash")
                .args(["-c", &script])
                .output()
                .expect("run target download script")
        };

        let tampered = run(&"b".repeat(64));
        assert!(
            !tampered.status.success(),
            "a digest mismatch must fail the download"
        );
        assert!(
            !archive.exists(),
            "a mismatched download must never be published to the installer"
        );

        let matched = run(&digest);
        assert!(
            matched.status.success(),
            "a matching digest must succeed:\n{}",
            String::from_utf8_lossy(&matched.stderr)
        );
        assert_eq!(
            std::fs::read(&archive).expect("read staged archive"),
            b"pretend release bytes",
            "the verified bytes must be published unchanged"
        );
    }

    #[test]
    fn install_body_stages_only_the_openbitfun_binary_under_its_real_name() {
        let body = install_body_script(
            "/home/user/.openbitfun/dispatch/install",
            "/home/user/.openbitfun/dispatch/install/archive.tar.gz",
            "1.2.3",
            &ArchiveSource::TargetDownload,
        );
        assert!(
            body.contains(r#"TARGET="$HOME/.local/bin/openbitfun""#),
            "the managed target must use the canonical CLI name"
        );
        assert!(
            body.contains(r#"NEW="$STAGE/openbitfun""#),
            "the binary must stage under its final filename"
        );
        assert!(
            !body.contains("LEGACY_TARGET") && !body.contains("LEGACY_NEW"),
            "the installer must not publish a companion or compatibility entrypoint"
        );
        assert!(body.contains(r#""productId":"openbitfun""#));
        assert!(body.contains(r#""dataNamespace":"openbitfun""#));
    }

    fn dispatch_capable_binary(capabilities: &str) -> String {
        format!(
            "#!/bin/bash\n\
             if [ \"${{1:-}}\" = dispatch ]; then\n\
             if [ \"${{2:-}}\" = probe ]; then\n\
             echo '{{\"productId\":\"{}\",\"dataNamespace\":\"{}\",\"protocolVersion\":{},\"capabilities\":{capabilities}}}'\n\
             fi\n\
             exit 0\n\
             fi\n\
             echo \"openbitfun 1.2.3\"\n",
            openbitfun_services_core::product_identity::product_id(),
            openbitfun_services_core::product_identity::data_namespace(),
            DISPATCH_PROTOCOL_VERSION,
        )
    }

    /// Mirrors a release that predates dispatch: the binary is healthy and
    /// reports the right version, but clap rejects the subcommand.
    const DISPATCH_LESS_PRIMARY: &str = "#!/bin/bash\n\
         if [ \"${1:-}\" = dispatch ]; then\n\
         echo \"error: unrecognized subcommand 'dispatch'\" >&2\n\
         exit 2\n\
         fi\n\
         echo \"openbitfun 1.2.3\"\n";

    #[cfg(unix)]
    #[test]
    fn a_build_without_dispatch_fails_the_install_instead_of_looking_healthy() {
        // The scenario that motivated this check: a release whose binary runs
        // and reports the expected version, but carries no dispatch support.
        // Without the guard the install "succeeds" and the target is then
        // reported incompatible, inviting an endless reinstall loop.
        let (output, temp) = run_install_body_fixture(DISPATCH_LESS_PRIMARY);
        let home = temp.path();
        assert!(
            !output.status.success(),
            "an install that cannot serve dispatch must fail"
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("does not provide dispatch support"),
            "the failure must name the cause: {stderr}"
        );
        assert!(
            stderr.contains("unrecognized subcommand"),
            "the underlying message must survive: {stderr}"
        );
        assert!(
            !home.join(".local/bin/openbitfun").exists(),
            "nothing may be published when the build cannot serve dispatch"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_dispatch_build_without_safe_worker_profile_selection_is_not_installed() {
        let unsafe_binary = dispatch_capable_binary("[]");
        let (output, temp) = run_install_body_fixture(&unsafe_binary);
        assert!(
            !output.status.success(),
            "a target that accepts jobs but cannot run workers must fail installation"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("lacks safe dispatch worker profile selection"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!temp.path().join(".local/bin/openbitfun").exists());
    }

    #[cfg(unix)]
    fn run_install_body_fixture(primary: &str) -> (std::process::Output, tempfile::TempDir) {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().to_path_buf();
        let install_dir = home.join(install_state_relative_dir());
        std::fs::create_dir_all(&install_dir).expect("install dir");
        let pkg = temp.path().join("pkg/openbitfun-cli-1.2.3-test");
        std::fs::create_dir_all(&pkg).expect("package dir");
        std::fs::write(pkg.join("openbitfun"), primary).expect("write binary");
        std::fs::set_permissions(
            pkg.join("openbitfun"),
            std::fs::Permissions::from_mode(0o755),
        )
        .expect("chmod package binary");
        let archive = install_dir.join("archive.tar.gz");
        assert!(std::process::Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(temp.path().join("pkg"))
            .arg("openbitfun-cli-1.2.3-test")
            .status()
            .expect("run tar")
            .success());
        std::fs::write(
            install_dir.join(format!("{INSTALL_STEM}.pid")),
            "1\ntest-token\n",
        )
        .expect("write pid marker");
        let script = to_unix_script(&install_body_script(
            &install_dir.to_string_lossy(),
            &archive.to_string_lossy(),
            "1.2.3",
            &ArchiveSource::TargetDownload,
        ));
        let output = std::process::Command::new("bash")
            .args(["-c", &script, "install-body", "test-token"])
            .env("HOME", &home)
            .output()
            .expect("run install body");
        (output, temp)
    }

    #[cfg(unix)]
    #[test]
    fn install_body_installs_only_openbitfun_onto_a_bare_host() {
        let binary = dispatch_capable_binary("[\"dispatch_worker_cli_profile\"]");
        let (output, temp) = run_install_body_fixture(&binary);
        let home = temp.path();

        assert!(
            output.status.success(),
            "install must succeed on a host with no pre-existing OpenBitFun CLI:\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(INSTALL_DONE_MARKER),
            "install must report completion"
        );

        let installed = home.join(".local/bin/openbitfun");
        let run = std::process::Command::new(&installed)
            .arg("--version")
            .output()
            .expect("run installed binary");
        assert!(run.status.success(), "openbitfun must run after install");
        assert!(String::from_utf8_lossy(&run.stdout).contains("openbitfun 1.2.3"));
        let installed_entries: Vec<_> = std::fs::read_dir(home.join(".local/bin"))
            .expect("read bin dir")
            .map(|entry| entry.expect("read installed entry").file_name())
            .collect();
        assert_eq!(
            installed_entries,
            vec![std::ffi::OsString::from("openbitfun")],
            "only the canonical CLI may remain; no aliases or staging directories"
        );
    }

    #[cfg(unix)]
    #[test]
    fn generated_install_scripts_parse_as_bash() {
        for script in [
            install_body_script(
                "/home/user/.openbitfun/dispatch/install",
                "/home/user/.openbitfun/dispatch/install/archive.tar.gz",
                "1.2.3",
                &ArchiveSource::TargetDownload,
            ),
            install_driver_script(
                "/home/user/.openbitfun/dispatch/install",
                "/home/user/.openbitfun/dispatch/install/install-cli-body.sh",
                "openbitfun-install-test-token",
            ),
            target_download_script(
                RemoteDownloader::Curl,
                RemoteDigestTool::Sha256Sum,
                "/home/user/.openbitfun/dispatch/install/archive.tar.gz",
                "https://example.invalid/archive.tar.gz",
                "https://openbitfun.example.invalid/archive.tar.gz",
                &"a".repeat(64),
            ),
            target_download_script(
                RemoteDownloader::Wget,
                RemoteDigestTool::Shasum,
                "/home/user/.openbitfun/dispatch/install/archive.tar.gz",
                "https://example.invalid/archive.tar.gz",
                "https://openbitfun.example.invalid/archive.tar.gz",
                &"a".repeat(64),
            ),
            install_poll_script(17),
            install_cancel_script(),
        ] {
            let output = std::process::Command::new("bash")
                .args(["-n", "-c", &to_unix_script(&script)])
                .output()
                .expect("parse generated shell");
            assert!(
                output.status.success(),
                "generated shell is invalid:\n{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn stale_installer_pid_never_signals_an_unrelated_process() {
        let temp = tempfile::tempdir().expect("temp dir");
        let state_dir = temp.path().join(install_state_relative_dir());
        std::fs::create_dir_all(&state_dir).expect("install state dir");
        let pid_path = state_dir.join(format!("{INSTALL_STEM}.pid"));
        let mut unrelated = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn unrelated process");

        std::fs::write(
            &pid_path,
            format!("{}\nstale-install-token\n", unrelated.id()),
        )
        .expect("stale pid marker");
        let poll = std::process::Command::new("bash")
            .args(["-c", &install_poll_script(0)])
            .env("HOME", temp.path())
            .output()
            .expect("poll stale installer");
        assert!(poll.status.success());
        assert!(
            String::from_utf8_lossy(&poll.stdout).contains("running=0"),
            "a reused PID must not be reported as the installer"
        );
        assert!(!pid_path.exists(), "poll must clear the stale marker");

        std::fs::write(
            &pid_path,
            format!("{}\nstale-install-token\n", unrelated.id()),
        )
        .expect("restore stale pid marker");
        std::fs::write(
            state_dir.join(format!("{INSTALL_STEM}.driver.pid")),
            format!("{}\nstale-driver-token\n", unrelated.id()),
        )
        .expect("stale driver pid marker");
        std::fs::write(
            state_dir.join(format!("{INSTALL_STEM}.preparing")),
            "stale-driver-token\n",
        )
        .expect("stale prepare marker");
        let cancel = std::process::Command::new("bash")
            .args(["-c", &install_cancel_script()])
            .env("HOME", temp.path())
            .output()
            .expect("cancel stale installer");
        assert!(cancel.status.success());
        assert!(
            unrelated
                .try_wait()
                .expect("inspect unrelated process")
                .is_none(),
            "cancellation must never signal a process that does not match the installer identity"
        );
        assert!(!pid_path.exists(), "cancel must clear the stale marker");

        unrelated.kill().expect("stop unrelated process");
        unrelated.wait().expect("reap unrelated process");
    }

    #[cfg(unix)]
    #[test]
    fn matching_installer_identity_is_cancelled() {
        let temp = tempfile::tempdir().expect("temp dir");
        let state_dir = temp.path().join(install_state_relative_dir());
        std::fs::create_dir_all(&state_dir).expect("install state dir");
        let body_path = state_dir.join(format!("{INSTALL_STEM}-body.sh"));
        std::fs::write(&body_path, "sleep 30\n").expect("installer body");
        let token = "openbitfun-install-test-token";
        let mut installer = std::process::Command::new("bash")
            .arg(&body_path)
            .arg(token)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn installer");
        std::fs::write(
            state_dir.join(format!("{INSTALL_STEM}.pid")),
            format!("{}\n{token}\n", installer.id()),
        )
        .expect("installer pid marker");

        let cancel = std::process::Command::new("bash")
            .args(["-c", &install_cancel_script()])
            .env("HOME", temp.path())
            .output()
            .expect("cancel installer");
        assert!(cancel.status.success());
        let stopped = installer
            .try_wait()
            .expect("inspect installer process")
            .is_some();
        if !stopped {
            installer.kill().expect("cleanup installer process");
            installer.wait().expect("reap installer process");
        }
        assert!(
            stopped,
            "the exact PID/token/body identity must be cancelled"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cancelled_prepare_token_prevents_the_driver_from_spawning() {
        let temp = tempfile::tempdir().expect("temp dir");
        let state_dir = temp.path().join(install_state_relative_dir());
        std::fs::create_dir_all(&state_dir).expect("install state dir");
        let body_path = state_dir.join(format!("{INSTALL_STEM}-body.sh"));
        let sentinel = temp.path().join("installer-started");
        std::fs::write(
            &body_path,
            format!("touch {}\n", shell_quote_posix(&sentinel.to_string_lossy())),
        )
        .expect("installer body");
        let token = "openbitfun-install-cancelled-before-driver";
        let driver = install_driver_script(
            &state_dir.to_string_lossy(),
            &body_path.to_string_lossy(),
            token,
        );

        let output = std::process::Command::new("bash")
            .args(["-c", &driver, "install-driver", token])
            .output()
            .expect("run invalidated driver");
        assert_eq!(output.status.code(), Some(130));
        assert!(
            !sentinel.exists(),
            "a driver whose prepare token was removed must not start the body"
        );
        assert!(
            !state_dir
                .join(format!("{INSTALL_STEM}.driver.pid"))
                .exists(),
            "the invalidated driver must clean its identity marker"
        );
    }

    #[cfg(unix)]
    #[test]
    fn dispatch_command_round_trips_quoted_paths_and_removes_request() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let bin_dir = temp.path().join("bin with space");
        std::fs::create_dir_all(&bin_dir).expect("bin dir");
        let cli = bin_dir.join("openbitfun's");
        std::fs::write(&cli, "#!/bin/sh\ncat\n").expect("fake CLI");
        let mut permissions = std::fs::metadata(&cli).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&cli, permissions).unwrap();

        let request = temp.path().join("request with ' quote.json");
        let payload = r#"{"prompt":"$(touch should-not-run); it's literal"}"#;
        std::fs::write(&request, payload).expect("request");
        let command =
            dispatch_command(&cli.to_string_lossy(), "submit", &request.to_string_lossy());
        assert!(
            !command.contains(payload),
            "request JSON must never be embedded in the shell command"
        );
        let output = std::process::Command::new("bash")
            .args(["-c", &command])
            .output()
            .expect("run quoted dispatch command");
        assert!(
            output.status.success(),
            "quoted command failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout), payload);
        assert!(!request.exists(), "EXIT trap must remove the request");
        assert!(!temp.path().join("should-not-run").exists());
    }

    #[test]
    fn release_target_accepts_supported_unix_architectures() {
        assert_eq!(
            release_target("Linux", "amd64").unwrap(),
            "x86_64-unknown-linux-gnu"
        );
        assert_eq!(
            release_target("Darwin", "arm64").unwrap(),
            "aarch64-apple-darwin"
        );
        assert!(release_target("Windows", "x86_64").is_err());
    }

    #[test]
    fn probe_prefers_the_managed_cli_over_an_incompatible_path_copy() {
        let script = probe_remote_target_script();
        let managed = script
            .find(r#"[ -x "$HOME/.local/bin/openbitfun" ]"#)
            .expect("managed CLI check");
        let path_lookup = script.find("command -v openbitfun").expect("PATH fallback");
        assert!(managed < path_lookup);
    }

    #[test]
    fn poll_metadata_split_accepts_lf_and_crlf() {
        let (head, output) = split_metadata_output("running=1\n---\nhello\n");
        assert_eq!(head, "running=1\n");
        assert_eq!(output, "hello\n");
        let (head, output) = split_metadata_output("running=1\r\n---\r\nhello\r\n");
        assert_eq!(head, "running=1\r\n");
        assert_eq!(output, "hello\r\n");
    }

    #[test]
    fn checksum_parser_used_by_dispatch_rejects_malformed_sidecars() {
        assert!(crate::remote_ssh::release_verify::parse_sha256(
            "not-a-checksum",
            "archive.tar.gz"
        )
        .is_err());
    }

    #[test]
    fn streaming_archive_limit_is_enforced_before_appending_a_chunk() {
        let mut archive = vec![1, 2, 3];
        extend_bounded_archive(&mut archive, &[4], 4).unwrap();
        assert_eq!(archive, vec![1, 2, 3, 4]);
        assert!(extend_bounded_archive(&mut archive, &[5], 4).is_err());
        assert_eq!(
            archive,
            vec![1, 2, 3, 4],
            "the over-limit chunk must never be buffered"
        );
    }

    #[test]
    fn model_config_sync_merges_only_the_ai_keys() {
        let payload = serde_json::json!({
            "models": [{"id": "m1", "enabled": true}],
            "default_models": {"primary": "m1"},
            "agent_model_selections": {"mode":{"kind":"model","model_ref":"m1"},"subagents":{"default":{"kind":"inherit"},"builtin":{},"fork":{"kind":"inherit"}}},
            "model_pools": {"version":1,"pools":[]},
        });
        let payload = validate_model_config_payload(&payload).expect("valid payload");

        // Fresh target: a minimal document containing only the ai section.
        let fresh: Value =
            serde_json::from_str(&merge_model_config(None, payload).unwrap()).unwrap();
        assert_eq!(fresh["ai"]["models"][0]["id"], "m1");

        // Existing target: everything outside the synced keys is preserved.
        let existing = r#"{
            "editor": {"font_size": 11},
            "ai": {"models": [], "max_rounds": 7}
        }"#;
        let merged: Value =
            serde_json::from_str(&merge_model_config(Some(existing), payload).unwrap()).unwrap();
        assert_eq!(merged["editor"]["font_size"], 11);
        assert_eq!(merged["ai"]["max_rounds"], 7);
        assert_eq!(merged["ai"]["models"][0]["id"], "m1");
        assert_eq!(merged["ai"]["default_models"]["primary"], "m1");
        assert_eq!(
            merged["ai"]["agent_model_selections"],
            payload["agent_model_selections"]
        );
        assert_eq!(merged["ai"]["model_pools"], payload["model_pools"]);

        // A corrupt target config aborts instead of being replaced.
        assert!(merge_model_config(Some("not json"), payload).is_err());
        assert!(merge_model_config(Some("[]"), payload).is_err());
    }

    #[test]
    fn model_config_payload_rejects_unknown_keys_and_empty_catalogs() {
        assert!(validate_model_config_payload(&serde_json::json!({
            "models": [{"id": "m1"}],
            "tool_permissions": {}
        }))
        .is_err());
        assert!(validate_model_config_payload(&serde_json::json!({
            "models": [{"id": "m1"}],
            "task_models": {"session_title": {"kind": "inherit"}}
        }))
        .is_err());
        assert!(validate_model_config_payload(&serde_json::json!({ "models": [] })).is_err());
        assert!(validate_model_config_payload(&serde_json::json!("models")).is_err());
    }

    #[test]
    fn installation_is_bound_to_the_exact_confirmed_release() {
        let confirmed = DispatchCliRelease {
            version: "1.2.3".to_string(),
            target: "aarch64-apple-darwin".to_string(),
            url: "https://example.test/openbitfun.tar.gz".to_string(),
            sha256: "a".repeat(64),
        };
        ensure_confirmed_release(&confirmed, &confirmed).expect("exact asset");

        let mut changed = confirmed.clone();
        changed.sha256 = "b".repeat(64);
        assert!(ensure_confirmed_release(&changed, &confirmed).is_err());
    }

    #[test]
    fn cli_install_failure_audit_details_are_structured_and_bounded() {
        let details = cli_install_failure_details(&"p".repeat(700), &"e".repeat(700));

        assert_eq!(
            details
                .get("phase")
                .and_then(Value::as_str)
                .expect("phase")
                .chars()
                .count(),
            500
        );
        assert_eq!(
            details
                .get("error")
                .and_then(Value::as_str)
                .expect("error")
                .chars()
                .count(),
            500
        );
        assert_eq!(details.get("output"), details.get("error"));
        assert_eq!(details.as_object().expect("details").len(), 3);
    }

    #[test]
    fn incompatible_dispatch_protocols_require_an_upgrade() {
        let capabilities = REQUIRED_DISPATCH_CAPABILITIES.clone();
        let compatible = serde_json::json!({
            "productId": openbitfun_services_core::product_identity::product_id(),
            "dataNamespace": openbitfun_services_core::product_identity::data_namespace(),
            "protocolVersion": DISPATCH_PROTOCOL_VERSION,
            "capabilities": capabilities,
        });
        assert!(dispatch_protocol_is_compatible(&compatible));

        let old = serde_json::json!({
            "productId": openbitfun_services_core::product_identity::product_id(),
            "dataNamespace": openbitfun_services_core::product_identity::data_namespace(),
            "protocolVersion": DISPATCH_PROTOCOL_VERSION - 1,
            "capabilities": capabilities,
        });
        assert!(!dispatch_protocol_is_compatible(&old));

        let missing = serde_json::json!({
            "productId": openbitfun_services_core::product_identity::product_id(),
            "dataNamespace": openbitfun_services_core::product_identity::data_namespace(),
            "protocolVersion": DISPATCH_PROTOCOL_VERSION,
            "capabilities": ["persistent_jobs", "cursor_events"],
        });
        assert!(!dispatch_protocol_is_compatible(&missing));

        let wrong_product = serde_json::json!({
            "productId": "acme",
            "dataNamespace": "acme",
            "protocolVersion": DISPATCH_PROTOCOL_VERSION,
            "capabilities": capabilities,
        });
        let error = validate_dispatch_protocol(&wrong_product, None)
            .expect_err("a different product must never share dispatch state");
        assert!(error
            .to_string()
            .contains("dispatch product is incompatible"));

        let mut reject_capabilities: Vec<&str> = REQUIRED_DISPATCH_CAPABILITIES
            .iter()
            .copied()
            .filter(|capability| !capability.starts_with("approval_"))
            .collect();
        reject_capabilities.push("approval_reject_and_report");
        let reject_only = serde_json::json!({
            "productId": openbitfun_services_core::product_identity::product_id(),
            "dataNamespace": openbitfun_services_core::product_identity::data_namespace(),
            "protocolVersion": DISPATCH_PROTOCOL_VERSION,
            "capabilities": reject_capabilities,
        });
        validate_dispatch_protocol(&reject_only, Some("reject-and-report"))
            .expect("selected policy is supported");
        assert!(validate_dispatch_protocol(&reject_only, Some("auto")).is_err());

        let mut unsafe_capabilities: Vec<&str> = REQUIRED_DISPATCH_CAPABILITIES
            .iter()
            .copied()
            .filter(|capability| {
                !capability.starts_with("approval_") && *capability != "dispatch_worker_cli_profile"
            })
            .collect();
        unsafe_capabilities.push("approval_reject_and_report");
        let unsafe_worker = serde_json::json!({
            "productId": openbitfun_services_core::product_identity::product_id(),
            "dataNamespace": openbitfun_services_core::product_identity::data_namespace(),
            "protocolVersion": DISPATCH_PROTOCOL_VERSION,
            "capabilities": unsafe_capabilities,
        });
        let error = validate_dispatch_protocol(&unsafe_worker, Some("reject-and-report"))
            .expect_err("a worker that can select product-full first must be rejected");
        assert!(
            error.to_string().contains("dispatch_worker_cli_profile"),
            "{error}"
        );
    }
}
