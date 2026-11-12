use anyhow::{anyhow, Context, Result};
#[cfg(unix)]
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs;
#[cfg(unix)]
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};
#[cfg(unix)]
use tar::Archive;

const GITHUB_MANIFEST: &str =
    "https://github.com/GCWing/OpenBitFun/releases/latest/download/linux-binaries-v1.json";
const OPENBITFUN_MANIFEST: &str = "https://openbitfun.com/release/linux-binaries-v1.json";
const AUTO_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Source-selection tuning. Mirrors the relay deploy path in
/// `src/crates/services/services-integrations/src/remote_ssh/relay_deploy.rs`,
/// which solves the same problem on the server side; keep the two in step.
///
/// A fixed-length ranged request measures GitHub throughput: bytes delivered
/// inside the window *is* the speed estimate used to keep GitHub first or move
/// the synchronized mirror ahead of it.
const PROBE_WINDOW: Duration = Duration::from_secs(10);
const PROBE_BYTES: u64 = 4 * 1024 * 1024;
/// GitHub stays first at or above this rate. Below it, a synchronized
/// OpenBitFun copy is preferred and GitHub remains the fallback.
const HEALTHY_THROUGHPUT: u64 = 512 * 1024;
/// Sustained below this counts as a dead link and we fail over. Deliberately
/// far under the healthy bar: a genuinely slow but only available source must
/// still be allowed to finish rather than loop forever.
const STALL_THROUGHPUT: u64 = 8 * 1024;
const STALL_WINDOW: Duration = Duration::from_secs(30);
/// Per-chunk read ceiling. Replaces a whole-request timeout, which made success
/// depend on archive size over link speed: a 30 MB archive under a 120 s total
/// timeout simply could not be fetched below ~250 KB/s, from any source.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Manifests are a few KB, so they may carry a total ceiling; archives may not.
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Ceiling for the whole startup-path check, which precedes the first paint.
const AUTO_CHECK_BUDGET: Duration = Duration::from_secs(10);
/// Hard ceiling on an archive held in memory. The checksum can only be verified
/// once the whole body has arrived, so without a cap a hostile or misconfigured
/// origin can stream until the process is OOM-killed and no integrity check ever
/// runs. Official CLI archives are tens of megabytes; this leaves ample room.
const MAX_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
/// How often a long download reports progress. Silence for minutes is
/// indistinguishable from a hang.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinuxBinariesManifest {
    schema_version: u32,
    version: String,
    platforms: std::collections::HashMap<String, LinuxPlatform>,
}

#[derive(Debug, Deserialize)]
struct LinuxPlatform {
    target: String,
    cli: ReleaseAsset,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseAsset {
    filename: String,
    url: String,
    sha256_url: String,
    /// Present once the release is signed; absent on older manifests.
    #[serde(default)]
    sig_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UpdateOutcome {
    Current,
    /// `--check` found a newer release but was asked not to install it.
    Available,
    Updated,
    Unsupported,
}

pub(crate) async fn run_manual(check_only: bool) -> Result<UpdateOutcome> {
    let _lock = if check_only || current_platform_key().is_none() {
        None
    } else {
        Some(InstallLock::acquire()?)
    };
    let result = update_from_configured_sources(check_only).await;
    // A background install writes to /dev/null, so this file is the only way its
    // failure ever reaches the user — the next launch reports it.
    if is_background_install() {
        match &result {
            Err(error) => record_background_failure(&format!("{error:#}")),
            Ok(_) => clear_background_failure(),
        }
    }
    let outcome = result?;
    match outcome {
        UpdateOutcome::Current => {
            println!(
                "OpenBitFun CLI is up to date ({}).",
                env!("CARGO_PKG_VERSION")
            )
        }
        // `try_source` already printed the available version and its source.
        UpdateOutcome::Available => println!("Run `openbitfun update` to install it."),
        UpdateOutcome::Updated => println!(
            "OpenBitFun CLI was updated successfully. Restart this command to use the new version."
        ),
        UpdateOutcome::Unsupported => println!(
            "OpenBitFun CLI self-update supports official Linux x86_64/ARM64 archive installations."
        ),
    }
    Ok(outcome)
}

/// Startup-path update check.
///
/// This only fetches the manifest — a few KB, fast even on a crawling link —
/// and hands the multi-megabyte archive to a detached child. Interactive launch
/// must never sit behind a transfer whose duration is set by the user's
/// bandwidth; the previous inline download could hold the TUI for minutes.
pub(crate) async fn maybe_run_automatic() {
    if !automatic_update_is_eligible() {
        return;
    }
    // Reported before the due-time gate, so a failure is not sat on for the rest
    // of the six-hour interval. Previously an automatic update could fail every
    // time and the user would only ever see it as "the version never changes".
    report_background_failure();
    if !automatic_check_is_due() {
        return;
    }
    mark_automatic_check();

    let client = match build_client() {
        Ok(client) => client,
        Err(error) => {
            tracing::debug!("Automatic CLI update check skipped: {error}");
            return;
        }
    };
    // Even a manifest fetch gets a tight leash here: this runs before the TUI
    // paints, and a check that is 6 hours overdue can wait for the next launch.
    let Ok((manifests, errors)) =
        tokio::time::timeout(AUTO_CHECK_BUDGET, fetch_manifests(&client)).await
    else {
        tracing::debug!("Automatic CLI update check timed out; continuing startup.");
        return;
    };
    if manifests.is_empty() {
        tracing::debug!("Automatic CLI update check failed: {}", errors.join("; "));
        return;
    }
    let newest = newest_version(&manifests);
    if !is_newer_version(&newest, env!("CARGO_PKG_VERSION")) {
        return;
    }

    match spawn_detached_install() {
        Ok(true) => eprintln!(
            "OpenBitFun CLI {newest} is downloading in the background; it will be used next launch."
        ),
        Ok(false) => tracing::debug!("A CLI update is already in progress; skipping."),
        Err(error) => tracing::debug!("Could not start background CLI update: {error}"),
    }
}

/// Run `openbitfun update` detached so it outlives this process. Returns false when
/// another install already holds the lock.
fn spawn_detached_install() -> Result<bool> {
    if InstallLock::is_held() {
        return Ok(false);
    }
    let exe = std::env::current_exe().context("resolve current OpenBitFun CLI executable")?;
    Command::new(exe)
        .arg("update")
        .env(BACKGROUND_INSTALL_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("spawn background CLI update")?;
    Ok(true)
}

/// Marks the detached child so it knows to leave a failure behind for the next
/// interactive launch to report.
const BACKGROUND_INSTALL_ENV: &str = "OPENBITFUN_CLI_BACKGROUND_UPDATE";

fn is_background_install() -> bool {
    std::env::var_os(BACKGROUND_INSTALL_ENV).is_some()
}

fn background_failure_path() -> Option<PathBuf> {
    crate::config::CliConfig::config_dir()
        .ok()
        .map(|dir| dir.join("update-last-error"))
}

fn record_background_failure(message: &str) {
    let Some(path) = background_failure_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, message);
}

fn clear_background_failure() {
    if let Some(path) = background_failure_path() {
        let _ = fs::remove_file(path);
    }
}

/// Print (once) the reason the last background install gave up.
fn report_background_failure() {
    let Some(path) = background_failure_path() else {
        return;
    };
    let Ok(message) = fs::read_to_string(&path) else {
        return;
    };
    let _ = fs::remove_file(&path);
    let message = message.trim();
    if message.is_empty() {
        return;
    }
    eprintln!("The last background OpenBitFun CLI update failed: {message}");
    eprintln!("Run `openbitfun update` to retry.");
}

/// Guards against two `openbitfun update` runs swapping the binary at once.
struct InstallLock {
    _file: fs::File,
}

impl InstallLock {
    fn path() -> Option<PathBuf> {
        std::env::current_exe()
            .ok()?
            .parent()
            .map(|parent| parent.join(".openbitfun-cli-install.lock"))
    }

    fn is_held() -> bool {
        Self::acquire().is_err()
    }

    fn acquire() -> Result<Self> {
        let path = Self::path()
            .ok_or_else(|| anyhow!("cannot resolve the CLI installation lock location"))?;
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let file = options.open(&path).with_context(|| {
            format!(
                "open installation lock {}; check directory permissions",
                path.display()
            )
        })?;
        file.try_lock().with_context(|| {
            format!(
                "another OpenBitFun CLI installation or update is already running ({})",
                path.display()
            )
        })?;
        Ok(Self { _file: file })
    }
}

async fn update_from_configured_sources(check_only: bool) -> Result<UpdateOutcome> {
    let Some(platform_key) = current_platform_key() else {
        return Ok(UpdateOutcome::Unsupported);
    };
    let current_exe =
        std::env::current_exe().context("resolve current OpenBitFun CLI executable")?;
    if is_development_binary(&current_exe) {
        return Ok(UpdateOutcome::Unsupported);
    }

    let client = build_client()?;
    let (manifests, errors) = fetch_manifests(&client).await;
    if manifests.is_empty() {
        return Err(anyhow!(
            "CLI update failed from both configured sources: {}",
            errors.join("; ")
        ));
    }

    let newest = newest_version(&manifests);
    if !is_newer_version(&newest, env!("CARGO_PKG_VERSION")) {
        return Ok(UpdateOutcome::Current);
    }
    if check_only {
        let from = manifests
            .iter()
            .filter(|(_, manifest)| manifest.version == newest)
            .map(|(source, _)| *source)
            .collect::<Vec<_>>()
            .join(", ");
        println!(
            "OpenBitFun CLI {} is available from {} (current {}).",
            newest,
            from,
            env!("CARGO_PKG_VERSION")
        );
        return Ok(UpdateOutcome::Available);
    }

    // Only sources that actually carry the newest version are candidates. During
    // the mirror's sync window openbitfun still advertises the previous release,
    // so it is simply not offering these bytes yet.
    let mut candidates = Vec::new();
    let mut skipped = Vec::new();
    // Checksum served by GitHub itself for this exact version. Verifying an
    // archive against a `.sha256` from the same host it came from proves only
    // that the transfer was not corrupted — a hostile mirror serves both and
    // passes. Binding to a different origin means one compromised mirror is not
    // enough.
    let mut canonical_sha256_url = None;
    let mut canonical_sig_url = None;
    for (source, manifest) in &manifests {
        if manifest.version != newest {
            continue;
        }
        match platform_asset(manifest, platform_key) {
            Ok(asset) => {
                if *source == "GitHub" {
                    canonical_sha256_url = Some(asset.sha256_url.clone());
                    canonical_sig_url = asset.sig_url.clone();
                }
                candidates.push(AssetCandidate {
                    source: if *source == "GitHub" {
                        ReleaseSource::GitHub
                    } else {
                        ReleaseSource::OpenBitFun
                    },
                    url: asset.url.clone(),
                    sha256_url: asset.sha256_url.clone(),
                    sig_url: asset.sig_url.clone(),
                    filename: asset.filename.clone(),
                });
            }
            Err(error) => skipped.push(format!("{source}: {error:#}")),
        }
    }
    if candidates.is_empty() {
        return Err(anyhow!(
            "no source offers a usable {platform_key} CLI asset for {newest}: {}",
            skipped.join("; ")
        ));
    }

    // Every candidate is the same asset, so any one names the staging file.
    let asset_filename = candidates[0].filename.clone();
    let ranked = order_sources(&client, candidates).await;
    if ranked
        .first()
        .is_some_and(|(candidate, _)| candidate.source == ReleaseSource::OpenBitFun)
    {
        if let Some((_, github_speed)) = ranked
            .iter()
            .find(|(candidate, _)| candidate.source == ReleaseSource::GitHub)
        {
            eprintln!(
                "GitHub update speed is {} KiB/s, under the {} KiB/s bar; trying the OpenBitFun mirror first.",
                github_speed / 1024,
                HEALTHY_THROUGHPUT / 1024
            );
        }
    }

    // Partial progress carries across sources: every source serves the same
    // artifact and the checksum catches a bad resume. It also carries across
    // *runs* — the automatic path installs from a detached child, and a child
    // killed at 90% should not start over on the next launch.
    let staging = PartialDownload::open(&newest, &asset_filename);
    let mut buffer = staging.resume();
    if !buffer.is_empty() {
        eprintln!(
            "Resuming a previous OpenBitFun CLI download at {} MB.",
            buffer.len() / (1024 * 1024)
        );
    }
    let mut failures = Vec::new();
    for (candidate, _) in &ranked {
        let outcome = download_resumable(&client, &candidate.url, &mut buffer).await;
        staging.save(&buffer);
        if let Err(error) = outcome {
            failures.push(format!("{}: {error:#}", candidate.url));
            continue;
        }
        let checksum_url = canonical_sha256_url
            .as_deref()
            .unwrap_or(candidate.sha256_url.as_str());
        let checksum_text = match download_text(&client, checksum_url).await {
            Ok(text) => text,
            // Falling back to the origin's own checksum is materially weaker, so
            // only do it when the canonical copy is genuinely unreachable.
            Err(error) if checksum_url != candidate.sha256_url => {
                eprintln!(
                    "Warning: canonical checksum at {checksum_url} is unreachable ({error:#}); \
                     falling back to the one served by the download origin, which only \
                     detects corruption, not a tampered mirror."
                );
                match download_text(&client, &candidate.sha256_url).await {
                    Ok(text) => text,
                    Err(error) => {
                        failures.push(format!("{}: {error:#}", candidate.sha256_url));
                        continue;
                    }
                }
            }
            Err(error) => {
                failures.push(format!("{checksum_url}: {error:#}"));
                continue;
            }
        };
        if let Err(error) = verify_sha256(&buffer, &checksum_text, &candidate.filename) {
            // Bad bytes, not a bad link: discard so the next source does not
            // resume on top of them.
            buffer.clear();
            staging.discard();
            failures.push(format!("{}: {error:#}", candidate.url));
            continue;
        }
        // Checksum passed, so the bytes are intact. Signature proves who made
        // them — the part a mirror or proxy cannot forge.
        if let Some(pubkey) = release_pubkey() {
            let sig_url = canonical_sig_url
                .as_deref()
                .or(candidate.sig_url.as_deref());
            let Some(sig_url) = sig_url else {
                return Err(anyhow!(
                    "this build requires signed releases but {newest} publishes no signature; \
                     refusing to install"
                ));
            };
            let signature = download_text(&client, sig_url)
                .await
                .with_context(|| format!("fetch release signature {sig_url}"))?;
            verify_signature(&buffer, &signature, pubkey)?;
        }

        install_archive(&buffer, &current_exe)?;
        staging.discard();
        restart_managed_daemon();
        println!("Updated to {newest} from {}", candidate.url);
        return Ok(UpdateOutcome::Updated);
    }

    Err(anyhow!(
        "CLI update could not be downloaded from any source: {}",
        failures.join("; ")
    ))
}

/// Download staging that survives the process.
///
/// The automatic path installs from a detached child; without this a child
/// killed near the end of a slow transfer would restart from zero on the next
/// launch, which on a 20 KB/s link means never finishing. Keyed by version and
/// filename so a stale partial from an older release is never resumed into.
struct PartialDownload {
    path: Option<PathBuf>,
}

impl PartialDownload {
    fn open(version: &str, filename: &str) -> Self {
        match crate::config::CliConfig::config_dir() {
            Ok(dir) => Self::open_in(&dir, version, filename),
            Err(_) => Self { path: None },
        }
    }

    /// Directory-injected form. Keeps the tests off `$HOME`, which is
    /// process-global and would make every other test in this binary flaky.
    fn open_in(dir: &Path, version: &str, filename: &str) -> Self {
        let key: String = format!("{version}-{filename}")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let path = dir.join(format!("update-partial-{key}"));

        // A partial from a different version or asset is dead weight, and
        // resuming one into this archive would only be caught by the checksum
        // after the whole transfer.
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let stale = entry.path();
                let is_partial = stale
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("update-partial-"));
                if is_partial && stale != path {
                    let _ = fs::remove_file(stale);
                }
            }
        }
        Self { path: Some(path) }
    }

    fn resume(&self) -> Vec<u8> {
        self.path
            .as_ref()
            .and_then(|path| fs::read(path).ok())
            .unwrap_or_default()
    }

    fn save(&self, buffer: &[u8]) {
        if buffer.is_empty() {
            return;
        }
        if let Some(path) = &self.path {
            let _ = fs::write(path, buffer);
        }
    }

    fn discard(&self) {
        if let Some(path) = &self.path {
            let _ = fs::remove_file(path);
        }
    }
}

/// One source's copy of the same archive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReleaseSource {
    GitHub,
    OpenBitFun,
}

#[derive(Debug, Clone)]
struct AssetCandidate {
    source: ReleaseSource,
    url: String,
    sha256_url: String,
    sig_url: Option<String>,
    filename: String,
}

async fn fetch_manifests(
    client: &Client,
) -> (Vec<(&'static str, LinuxBinariesManifest)>, Vec<String>) {
    // Concurrently: one unreachable source must not add its whole ceiling to
    // the other's, which matters most on the startup path.
    let (github, mirror) = tokio::join!(
        fetch_manifest(client, GITHUB_MANIFEST),
        fetch_manifest(client, OPENBITFUN_MANIFEST),
    );

    let mut manifests = Vec::new();
    let mut errors = Vec::new();
    for (source, result) in [("GitHub", github), ("openbitfun.com", mirror)] {
        match result {
            Ok(manifest) => manifests.push((source, manifest)),
            Err(error) => errors.push(format!("{source}: {error:#}")),
        }
    }
    (manifests, errors)
}

async fn fetch_manifest(client: &Client, manifest_url: &str) -> Result<LinuxBinariesManifest> {
    // Manifests are a few KB, so a short total ceiling is safe here even though
    // archive downloads deliberately have none.
    let manifest = tokio::time::timeout(MANIFEST_TIMEOUT, async {
        client
            .get(manifest_url)
            .send()
            .await
            .with_context(|| format!("request {manifest_url}"))?
            .error_for_status()
            .with_context(|| format!("fetch {manifest_url}"))?
            .json::<LinuxBinariesManifest>()
            .await
            .with_context(|| format!("parse {manifest_url}"))
    })
    .await
    .map_err(|_| anyhow!("{manifest_url} did not answer within {MANIFEST_TIMEOUT:?}"))??;

    if manifest.schema_version != 1 {
        return Err(anyhow!(
            "unsupported Linux binaries manifest schema {}",
            manifest.schema_version
        ));
    }
    Ok(manifest)
}

fn newest_version(manifests: &[(&'static str, LinuxBinariesManifest)]) -> String {
    let mut newest = manifests[0].1.version.clone();
    for (_, manifest) in manifests {
        if is_newer_version(&manifest.version, &newest) {
            newest = manifest.version.clone();
        }
    }
    newest
}

fn platform_asset<'a>(
    manifest: &'a LinuxBinariesManifest,
    platform_key: &str,
) -> Result<&'a ReleaseAsset> {
    let platform = manifest
        .platforms
        .get(platform_key)
        .ok_or_else(|| anyhow!("manifest does not contain {platform_key}"))?;
    let expected_target = match platform_key {
        "linux-x86_64" => "x86_64-unknown-linux-gnu",
        "linux-aarch64" => "aarch64-unknown-linux-gnu",
        _ => return Err(anyhow!("unsupported updater platform {platform_key}")),
    };
    if platform.target != expected_target {
        return Err(anyhow!(
            "manifest target {} does not match {}",
            platform.target,
            expected_target
        ));
    }
    if !platform.cli.filename.ends_with(".tar.gz") {
        return Err(anyhow!("CLI release asset is not a tar.gz archive"));
    }
    Ok(&platform.cli)
}

fn build_client() -> Result<Client> {
    openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
    Client::builder()
        .connect_timeout(Duration::from_secs(8))
        // Deliberately no `.timeout()`: a whole-request ceiling turns "slow" into
        // "impossible" for any archive larger than ceiling x link speed. Stalls
        // are caught by READ_TIMEOUT plus the throughput floor below.
        .read_timeout(READ_TIMEOUT)
        .build()
        .context("build CLI updater HTTP client")
}

/// Bytes a source delivers inside [`PROBE_WINDOW`], i.e. its throughput.
/// A source that errors or answers nothing scores 0 but is still attempted
/// later: some CDNs refuse ranged requests while serving full ones fine.
async fn probe_throughput(client: &Client, url: &str, window: Duration) -> u64 {
    let started = Instant::now();
    let request = client
        .get(url)
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", PROBE_BYTES - 1),
        )
        .send();
    let Ok(Ok(response)) = tokio::time::timeout(window, request).await else {
        return 0;
    };
    if !response.status().is_success() {
        return 0;
    }

    let mut received: u64 = 0;
    let mut stream = response.bytes_stream();
    loop {
        let remaining = match window.checked_sub(started.elapsed()) {
            Some(left) if !left.is_zero() => left,
            _ => break,
        };
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(chunk))) => received += chunk.len() as u64,
            // Timed out (window closed) or the body ended early.
            _ => break,
        }
        if received >= PROBE_BYTES {
            break;
        }
    }

    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    (received as f64 / elapsed) as u64
}

/// Keep GitHub first while it clears the healthy floor. If it does not, put the
/// mirror first and retain GitHub as the final fallback. Every candidate still
/// carries the same release version and passes the integrity gates below.
async fn order_sources(
    client: &Client,
    candidates: Vec<AssetCandidate>,
) -> Vec<(AssetCandidate, u64)> {
    order_sources_with_window(client, candidates, PROBE_WINDOW).await
}

async fn order_sources_with_window(
    client: &Client,
    mut candidates: Vec<AssetCandidate>,
    window: Duration,
) -> Vec<(AssetCandidate, u64)> {
    let Some(github_index) = candidates
        .iter()
        .position(|candidate| candidate.source == ReleaseSource::GitHub)
    else {
        return candidates
            .into_iter()
            .map(|candidate| (candidate, 0))
            .collect();
    };
    let github_speed = probe_throughput(client, &candidates[github_index].url, window).await;
    tracing::debug!(
        "CLI update GitHub probe: {github_speed} B/s from {}",
        candidates[github_index].url
    );

    if github_speed >= HEALTHY_THROUGHPUT
        || !candidates
            .iter()
            .any(|candidate| candidate.source == ReleaseSource::OpenBitFun)
    {
        candidates.swap(0, github_index);
    } else if let Some(mirror_index) = candidates
        .iter()
        .position(|candidate| candidate.source == ReleaseSource::OpenBitFun)
    {
        candidates.swap(0, mirror_index);
    }

    candidates
        .into_iter()
        .map(|candidate| {
            let speed = if candidate.source == ReleaseSource::GitHub {
                github_speed
            } else {
                0
            };
            (candidate, speed)
        })
        .collect()
}

/// Stream a body, appending to `buffer`, aborting if throughput stays under
/// [`STALL_THROUGHPUT`] across a [`STALL_WINDOW`] slice.
async fn stream_with_stall_guard(
    response: reqwest::Response,
    buffer: &mut Vec<u8>,
    url: &str,
) -> Result<()> {
    // `Content-Length` is the server's claim, not a promise, so it only shapes
    // the progress line; the hard limit below is what actually bounds memory.
    let expected_total = response
        .content_length()
        .map(|remaining| remaining as usize + buffer.len());
    let mut stream = response.bytes_stream();
    let mut window_start = Instant::now();
    let mut window_bytes: u64 = 0;
    let mut last_report = Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("read {url}"))?;
        if buffer.len() + chunk.len() > MAX_ARCHIVE_BYTES {
            return Err(anyhow!(
                "release archive exceeds the {} MB ceiling; refusing to keep reading",
                MAX_ARCHIVE_BYTES / (1024 * 1024)
            ));
        }
        buffer.extend_from_slice(&chunk);
        window_bytes += chunk.len() as u64;

        if last_report.elapsed() >= PROGRESS_INTERVAL {
            report_progress(buffer.len(), expected_total);
            last_report = Instant::now();
        }

        let elapsed = window_start.elapsed();
        if elapsed >= STALL_WINDOW {
            let rate = window_bytes / elapsed.as_secs().max(1);
            if rate < STALL_THROUGHPUT {
                return Err(anyhow!(
                    "source stalled at {} KB/s (need {} KB/s)",
                    rate / 1024,
                    STALL_THROUGHPUT / 1024
                ));
            }
            window_start = Instant::now();
            window_bytes = 0;
        }
    }
    Ok(())
}

fn report_progress(downloaded: usize, expected_total: Option<usize>) {
    let megabytes = |bytes: usize| bytes as f64 / (1024.0 * 1024.0);
    match expected_total {
        Some(total) if total > 0 => eprintln!(
            "  downloaded {:.1} MB of {:.1} MB ({}%)",
            megabytes(downloaded),
            megabytes(total),
            downloaded.saturating_mul(100) / total
        ),
        _ => eprintln!("  downloaded {:.1} MB", megabytes(downloaded)),
    }
}

/// Download `url`, resuming with a Range request when a previous source left a
/// partial body. Every source serves an identical artifact, so partial progress
/// carries across sources; a bad resume is caught by the checksum.
async fn download_resumable(client: &Client, url: &str, buffer: &mut Vec<u8>) -> Result<()> {
    let mut request = client.get(url);
    if !buffer.is_empty() {
        request = request.header(reqwest::header::RANGE, format!("bytes={}-", buffer.len()));
    }
    let response = request
        .send()
        .await
        .with_context(|| format!("request {url}"))?;

    // A server that ignores Range answers 200 with the whole body; restart
    // cleanly rather than concatenating a duplicate prefix onto the partial.
    if !buffer.is_empty() && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        buffer.clear();
    }
    let response = response
        .error_for_status()
        .with_context(|| format!("download {url}"))?;
    stream_with_stall_guard(response, buffer, url).await
}

async fn download_text(client: &Client, url: &str) -> Result<String> {
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

/// Ed25519 (minisign) public key for official release archives, injected at
/// build time from the same `TAURI_UPDATER_PUBKEY` the Desktop updater trusts.
///
/// Forks that publish their own releases override this with their own key.
const RELEASE_PUBKEY: Option<&str> = option_env!("OPENBITFUN_RELEASE_PUBKEY");

/// The official OpenBitFun release public key (minisign key ID `50F47CBE6CC0A376`),
/// base64-wrapped the way Tauri wraps `minisign.pub`. Public data — each
/// release ships it as the `minisign.pub` asset — and the update source above
/// is pinned to the official repository, so local and fork builds verifying
/// against it is strictly stronger than their old checksum-only fallback.
const OFFICIAL_RELEASE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDUwRjQ3Q0JFNkNDMEEzNzYKUldSMm84QnN2bnowVU9CYzNOb1RWVzA2d2RpR003cExQM0xwaUw0QTNTcDRueGtCc1dsSlJUeG4K";

/// The trust root for release archives. Always present, so signature
/// verification is mandatory on every update path.
fn release_pubkey() -> Option<&'static str> {
    RELEASE_PUBKEY
        .filter(|key| !key.trim().is_empty())
        .or(Some(OFFICIAL_RELEASE_PUBKEY))
}

/// Verify a Tauri-format `.sig` (base64 of a minisign signature file) over the
/// archive. The public key accepts both current raw Tauri values and the legacy
/// base64 wrapper.
///
/// A checksum only proves the transfer was not corrupted: whoever serves the
/// archive can serve a matching `.sha256`. A signature proves the bytes came
/// from whoever holds the release key, which is what actually protects the
/// third-party GitHub proxy and mirror paths.
fn verify_signature(archive: &[u8], signature_b64: &str, pubkey: &str) -> Result<()> {
    use base64::Engine as _;

    let public_key_text = if pubkey.trim().starts_with("untrusted comment:") {
        pubkey.trim().to_owned()
    } else {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(pubkey.trim().as_bytes())
            .context("decode release public key")?;
        String::from_utf8(bytes).context("decode release public key as UTF-8")?
    };
    let public_key = minisign_verify::PublicKey::decode(&public_key_text)
        .map_err(|error| anyhow!("invalid release public key: {error}"))?;
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_b64.trim().as_bytes())
        .context("decode release signature")?;
    let signature_text =
        String::from_utf8(signature_bytes).context("decode release signature as UTF-8")?;
    let signature = minisign_verify::Signature::decode(&signature_text)
        .map_err(|error| anyhow!("invalid release signature: {error}"))?;
    public_key
        .verify(archive, &signature, false)
        .map_err(|error| anyhow!("release signature does not match the archive: {error}"))
}

fn verify_sha256(archive: &[u8], checksum_text: &str, filename: &str) -> Result<()> {
    let expected = checksum_text
        .split_whitespace()
        .next()
        .filter(|value| value.len() == 64)
        .ok_or_else(|| anyhow!("invalid SHA256 file for {filename}"))?;
    let actual = format!("{:x}", Sha256::digest(archive));
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(anyhow!("SHA256 mismatch for {filename}"));
    }
    Ok(())
}

#[cfg(unix)]
fn install_archive(archive: &[u8], current_exe: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let install_dir = current_exe
        .parent()
        .ok_or_else(|| anyhow!("current executable has no parent directory"))?;
    if current_exe.file_name().and_then(|name| name.to_str()) != Some("openbitfun") {
        return Err(anyhow!(
            "self-update requires the official executable name `openbitfun`"
        ));
    }
    let plugin_host_target = install_dir.join("resources").join("ext-host");

    let extract_dir = tempfile::tempdir().context("create CLI update extraction directory")?;
    Archive::new(GzDecoder::new(Cursor::new(archive)))
        .unpack(extract_dir.path())
        .context("extract CLI update archive")?;
    let package_dir = find_package_dir(extract_dir.path())?;
    let new_primary = package_dir.join("openbitfun");
    let new_plugin_host = package_dir.join("resources").join("ext-host");
    validate_entrypoint(&new_primary)?;
    validate_plugin_host_resources(&new_plugin_host)?;

    let update_prefix = format!(
        "{}-update.",
        openbitfun_core_types::product_identity::hidden_data_directory()
    );
    let stage = tempfile::Builder::new()
        .prefix(&update_prefix)
        .tempdir_in(install_dir)
        .with_context(|| {
            format!(
                "create update staging directory in {}",
                install_dir.display()
            )
        })?;
    let staged_primary = stage.path().join("openbitfun");
    let staged_plugin_host = stage.path().join("ext-host");
    fs::copy(&new_primary, &staged_primary).context("stage openbitfun")?;
    copy_plugin_host_resources(&new_plugin_host, &staged_plugin_host)?;
    fs::set_permissions(&staged_primary, fs::Permissions::from_mode(0o755))?;
    validate_entrypoint(&staged_primary)?;
    validate_plugin_host_resources(&staged_plugin_host)?;

    let primary_backup = stage.path().join("previous-openbitfun");
    let plugin_host_backup = stage.path().join("previous-ext-host");
    let plugin_host_existed = plugin_host_target.is_dir();

    // Rollback runs while something has already gone wrong, so its own failures
    // are the ones that matter most: they are the difference between "the update
    // did not apply" and "there is no working `openbitfun` on this machine any
    // more". Swallowing them leaves the user with a broken install and no clue.
    let mut rollback_failures: Vec<String> = Vec::new();
    let restore = |from: &Path, to: &Path, rollback_failures: &mut Vec<String>| {
        if let Err(error) = fs::rename(from, to) {
            rollback_failures.push(format!("restore {}: {error}", to.display()));
        }
    };
    let rollback_error = |error: std::io::Error, step: &str, failures: Vec<String>| {
        let base = anyhow!(error).context(step.to_string());
        if failures.is_empty() {
            return base;
        }
        base.context(format!(
            "the previous CLI could NOT be put back ({}); reinstall OpenBitFun manually",
            failures.join("; ")
        ))
    };

    // Failed rollback must retain the only recovery copies instead of allowing
    // TempDir's destructor to erase them during unwinding.
    let retained_stage = stage.keep();
    fs::rename(current_exe, &primary_backup).context("back up current openbitfun")?;
    if plugin_host_existed {
        if let Err(error) = fs::rename(&plugin_host_target, &plugin_host_backup) {
            restore(&primary_backup, current_exe, &mut rollback_failures);
            return Err(rollback_error(
                error,
                "back up current plugin Host resources",
                rollback_failures,
            ));
        }
    }
    if let Err(error) = fs::rename(&staged_primary, current_exe) {
        if plugin_host_existed {
            restore(
                &plugin_host_backup,
                &plugin_host_target,
                &mut rollback_failures,
            );
        }
        restore(&primary_backup, current_exe, &mut rollback_failures);
        return Err(rollback_error(
            error,
            "install updated openbitfun",
            rollback_failures,
        ));
    }
    if let Err(error) = fs::create_dir_all(
        plugin_host_target
            .parent()
            .expect("plugin Host resource directory has a parent"),
    ) {
        if let Err(remove_error) = fs::remove_file(current_exe) {
            rollback_failures.push(format!("remove {}: {remove_error}", current_exe.display()));
        }
        if plugin_host_existed {
            restore(
                &plugin_host_backup,
                &plugin_host_target,
                &mut rollback_failures,
            );
        }
        restore(&primary_backup, current_exe, &mut rollback_failures);
        return Err(rollback_error(
            error,
            "create plugin Host resource directory",
            rollback_failures,
        ));
    }
    if let Err(error) = fs::rename(&staged_plugin_host, &plugin_host_target) {
        if let Err(remove_error) = fs::remove_file(current_exe) {
            rollback_failures.push(format!("remove {}: {remove_error}", current_exe.display()));
        }
        if plugin_host_existed {
            restore(
                &plugin_host_backup,
                &plugin_host_target,
                &mut rollback_failures,
            );
        }
        restore(&primary_backup, current_exe, &mut rollback_failures);
        return Err(rollback_error(
            error,
            "install updated plugin Host resources",
            rollback_failures,
        ));
    }
    let validation = validate_entrypoint(current_exe)
        .and_then(|_| validate_plugin_host_resources(&plugin_host_target));
    if let Err(error) = validation {
        if let Err(remove_error) = fs::remove_file(current_exe) {
            rollback_failures.push(format!("remove {}: {remove_error}", current_exe.display()));
        }
        if let Err(remove_error) = fs::remove_dir_all(&plugin_host_target) {
            rollback_failures.push(format!(
                "remove {}: {remove_error}",
                plugin_host_target.display()
            ));
        }
        if plugin_host_existed {
            restore(
                &plugin_host_backup,
                &plugin_host_target,
                &mut rollback_failures,
            );
        }
        restore(&primary_backup, current_exe, &mut rollback_failures);
        let failed = error.context("validate installed CLI update");
        if rollback_failures.is_empty() {
            return Err(failed);
        }
        return Err(failed.context(format!(
            "the previous CLI could NOT be put back ({}); reinstall OpenBitFun manually",
            rollback_failures.join("; ")
        )));
    }
    if let Err(error) = fs::remove_dir_all(&retained_stage) {
        tracing::warn!(
            "CLI update completed; cleanup remains at {}: {error}",
            retained_stage.display()
        );
    }
    Ok(())
}

#[cfg(not(unix))]
fn install_archive(_archive: &[u8], _current_exe: &Path) -> Result<()> {
    Err(anyhow!("CLI self-update is only available on Linux"))
}

fn find_package_dir(root: &Path) -> Result<PathBuf> {
    for entry in fs::read_dir(root).context("inspect CLI update archive")? {
        let path = entry?.path();
        if path.is_dir() && path.join("openbitfun").is_file() {
            return Ok(path);
        }
    }
    Err(anyhow!("CLI update archive does not contain openbitfun"))
}

fn validate_entrypoint(executable: &Path) -> Result<()> {
    let status = Command::new(executable)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("run {}", executable.display()))?;
    if !status.success() {
        return Err(anyhow!("{} --version failed", executable.display()));
    }
    Ok(())
}

fn validate_plugin_host_resources(directory: &Path) -> Result<()> {
    for entry in ["extension-host.js"] {
        let path = directory.join(entry);
        if !path.is_file() {
            return Err(anyhow!(
                "CLI package is missing plugin Host resource {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn copy_plugin_host_resources(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination).with_context(|| {
        format!(
            "create plugin Host staging directory {}",
            destination.display()
        )
    })?;
    for entry in ["extension-host.js"] {
        fs::copy(source.join(entry), destination.join(entry))
            .with_context(|| format!("stage plugin Host resource {entry}"))?;
    }
    Ok(())
}

fn current_platform_key() -> Option<&'static str> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    match std::env::consts::ARCH {
        "x86_64" => Some("linux-x86_64"),
        "aarch64" => Some("linux-aarch64"),
        _ => None,
    }
}

fn is_development_binary(executable: &Path) -> bool {
    executable
        .components()
        .any(|component| component.as_os_str() == "target")
}

fn release_core(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split(['-', '+']).next()?.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

fn is_newer_version(candidate: &str, current: &str) -> bool {
    matches!((release_core(candidate), release_core(current)), (Some(next), Some(now)) if next > now)
}

fn automatic_update_is_eligible() -> bool {
    if std::env::var_os("OPENBITFUN_CLI_DISABLE_AUTO_UPDATE").is_some()
        || !release_version_allows_automatic_update(env!("CARGO_PKG_VERSION"))
    {
        return false;
    }
    std::env::current_exe()
        .ok()
        .is_some_and(|path| current_platform_key().is_some() && !is_development_binary(&path))
}

fn release_version_allows_automatic_update(version: &str) -> bool {
    matches!(release_core(version), Some((major, _, _)) if major >= 1)
        && !version.contains("-nightly.")
        && !version.contains("-beta.")
}

/// Share the CLI's own config directory so a relocated profile (E2E storage
/// guard, non-default home) does not silently re-check on every launch.
fn automatic_stamp_path() -> Option<PathBuf> {
    crate::config::CliConfig::config_dir()
        .ok()
        .map(|dir| dir.join("last-update-check"))
}

fn automatic_check_is_due() -> bool {
    let Some(path) = automatic_stamp_path() else {
        return false;
    };
    let Ok(modified) = fs::metadata(path).and_then(|metadata| metadata.modified()) else {
        return true;
    };
    SystemTime::now()
        .duration_since(modified)
        .map_or(true, |elapsed| elapsed >= AUTO_CHECK_INTERVAL)
}

fn mark_automatic_check() {
    let Some(path) = automatic_stamp_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, env!("CARGO_PKG_VERSION"));
}

fn restart_managed_daemon() {
    // `dirs::config_dir()` honours `XDG_CONFIG_HOME`, which is where systemd
    // --user actually looks. Hard-coding `~/.config` missed the unit on any host
    // that relocates it, and the daemon then kept running the old binary.
    //
    // Both are checked because an install predating this could have written the
    // unit to `~/.config` on a host that sets `XDG_CONFIG_HOME` elsewhere; a
    // `try-restart` for a unit systemd does not know is a harmless no-op, while
    // missing one leaves a stale daemon behind.
    let candidates = [
        dirs::config_dir(),
        dirs::home_dir().map(|it| it.join(".config")),
    ];
    let installed = candidates.iter().flatten().any(|dir| {
        dir.join("systemd/user/openbitfun-cli-daemon.service")
            .is_file()
    });
    if installed {
        let _ = Command::new("systemctl")
            .args(["--user", "try-restart", "openbitfun-cli-daemon.service"])
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Minimal HTTP/1.1 origin that serves `body` at a fixed rate, honours
    /// `Range: bytes=<n>-` and can be told to hang up mid-response. Enough to
    /// exercise the parts of the updater that only misbehave on a slow link.
    struct StubOrigin {
        url: String,
    }

    impl StubOrigin {
        async fn spawn(body: Arc<Vec<u8>>, chunk: usize, delay: Duration, truncate: bool) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let url = format!("http://{}/asset.tar.gz", listener.local_addr().unwrap());
            tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        return;
                    };
                    let body = Arc::clone(&body);
                    tokio::spawn(async move {
                        let mut request = vec![0u8; 2048];
                        let read = socket.read(&mut request).await.unwrap_or(0);
                        let text = String::from_utf8_lossy(&request[..read]).to_string();

                        let start = text
                            .lines()
                            .find_map(|line| {
                                let rest = line.strip_prefix("range: bytes=").or_else(|| {
                                    line.to_ascii_lowercase()
                                        .starts_with("range: bytes=")
                                        .then(|| &line["range: bytes=".len()..])
                                })?;
                                rest.split('-').next()?.trim().parse::<usize>().ok()
                            })
                            .unwrap_or(0)
                            .min(body.len());

                        let slice = &body[start..];
                        let status = if start > 0 {
                            "206 Partial Content"
                        } else {
                            "200 OK"
                        };
                        let header = format!(
                            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\r\n",
                            slice.len()
                        );
                        if socket.write_all(header.as_bytes()).await.is_err() {
                            return;
                        }

                        let stop = if truncate {
                            slice.len() / 3
                        } else {
                            slice.len()
                        };
                        let mut sent = 0usize;
                        while sent < stop {
                            let end = (sent + chunk).min(stop);
                            if socket.write_all(&slice[sent..end]).await.is_err() {
                                return;
                            }
                            let _ = socket.flush().await;
                            sent = end;
                            if !delay.is_zero() {
                                tokio::time::sleep(delay).await;
                            }
                        }
                    });
                }
            });
            Self { url }
        }

        fn candidate(&self, source: ReleaseSource, filename: &str) -> AssetCandidate {
            AssetCandidate {
                source,
                url: self.url.clone(),
                sha256_url: format!("{}.sha256", self.url),
                sig_url: None,
                filename: filename.to_string(),
            }
        }
    }

    fn payload(size: usize) -> Arc<Vec<u8>> {
        Arc::new((0..size).map(|index| (index % 251) as u8).collect())
    }

    #[tokio::test]
    async fn healthy_github_remains_first_even_when_the_mirror_is_available() {
        let body = payload(1024 * 1024);
        let github = StubOrigin::spawn(Arc::clone(&body), 64 * 1024, Duration::ZERO, false).await;
        let mirror = StubOrigin::spawn(Arc::clone(&body), 64 * 1024, Duration::ZERO, false).await;
        let client = build_client().expect("client");

        let ordered = order_sources_with_window(
            &client,
            vec![
                mirror.candidate(ReleaseSource::OpenBitFun, "a.tar.gz"),
                github.candidate(ReleaseSource::GitHub, "a.tar.gz"),
            ],
            Duration::from_secs(1),
        )
        .await;

        assert_eq!(ordered[0].0.source, ReleaseSource::GitHub);
        assert!(ordered[0].1 >= HEALTHY_THROUGHPUT);
    }

    #[tokio::test]
    async fn slow_github_moves_the_mirror_first() {
        let body = payload(1024 * 1024);
        // 2 KiB every 20 ms is roughly 100 KiB/s, below the 512 KiB/s floor.
        let github =
            StubOrigin::spawn(Arc::clone(&body), 2048, Duration::from_millis(20), false).await;
        let mirror = StubOrigin::spawn(Arc::clone(&body), 64 * 1024, Duration::ZERO, false).await;
        let client = build_client().expect("client");

        let ordered = order_sources_with_window(
            &client,
            vec![
                github.candidate(ReleaseSource::GitHub, "a.tar.gz"),
                mirror.candidate(ReleaseSource::OpenBitFun, "a.tar.gz"),
            ],
            Duration::from_millis(400),
        )
        .await;

        assert_eq!(ordered[0].0.source, ReleaseSource::OpenBitFun);
        let github_speed = ordered
            .iter()
            .find(|(candidate, _)| candidate.source == ReleaseSource::GitHub)
            .map(|(_, speed)| *speed)
            .expect("GitHub candidate");
        assert!(github_speed < HEALTHY_THROUGHPUT);
    }

    /// The regression that made slow links fail outright: a whole-request
    /// timeout meant success depended on archive size over link speed. This
    /// body takes far longer than the old 120 s ceiling would have allowed to
    /// be proportionally, and must still complete.
    #[tokio::test]
    async fn slow_but_alive_source_completes() {
        let body = payload(128 * 1024);
        let slow =
            StubOrigin::spawn(Arc::clone(&body), 4096, Duration::from_millis(15), false).await;
        let client = build_client().expect("client");

        let mut buffer = Vec::new();
        download_resumable(&client, &slow.url, &mut buffer)
            .await
            .expect("slow source must still finish");
        assert_eq!(buffer, *body);
    }

    #[tokio::test]
    async fn partial_download_resumes_across_sources() {
        let body = payload(96 * 1024);
        let truncating = StubOrigin::spawn(Arc::clone(&body), 8192, Duration::ZERO, true).await;
        let complete = StubOrigin::spawn(Arc::clone(&body), 8192, Duration::ZERO, false).await;
        let client = build_client().expect("client");

        let mut buffer = Vec::new();
        // First source hangs up early, leaving a partial body behind.
        let _ = download_resumable(&client, &truncating.url, &mut buffer).await;
        let partial = buffer.len();
        assert!(
            partial > 0 && partial < body.len(),
            "expected a partial body"
        );

        // Second source must continue from there, not restart.
        download_resumable(&client, &complete.url, &mut buffer)
            .await
            .expect("resume");
        assert_eq!(buffer, *body, "resumed body must match the original");
    }

    #[tokio::test]
    async fn unreachable_source_scores_zero_without_hanging() {
        let client = build_client().expect("client");
        // Port 1 on loopback refuses immediately.
        let speed = probe_throughput(&client, "http://127.0.0.1:1/asset", PROBE_WINDOW).await;
        assert_eq!(speed, 0);
    }

    /// A background installer killed mid-transfer must resume, not restart —
    /// on a slow link restarting means never finishing. A partial from a
    /// different release must never be resumed into.
    #[test]
    fn staged_partial_resumes_and_evicts_other_versions() {
        let dir = tempfile::tempdir().expect("temp dir");
        let stage =
            |version: &str, filename: &str| PartialDownload::open_in(dir.path(), version, filename);

        let first = stage("1.0.0", "openbitfun-cli-1.0.0-x86_64.tar.gz");
        assert!(first.resume().is_empty(), "nothing staged yet");
        first.save(b"partial-bytes");
        assert_eq!(
            stage("1.0.0", "openbitfun-cli-1.0.0-x86_64.tar.gz").resume(),
            b"partial-bytes",
            "same version and asset must resume"
        );

        // Opening a different version evicts the stale partial rather than
        // resuming a mismatched archive into the new one.
        let newer = stage("1.0.1", "openbitfun-cli-1.0.1-x86_64.tar.gz");
        assert!(newer.resume().is_empty());
        assert!(
            stage("1.0.0", "openbitfun-cli-1.0.0-x86_64.tar.gz")
                .resume()
                .is_empty(),
            "the superseded partial must be gone"
        );

        newer.save(b"abc");
        newer.discard();
        assert!(newer.resume().is_empty(), "discard clears the staging file");
    }

    #[test]
    fn newest_version_wins_across_manifests() {
        let manifest = |version: &str| LinuxBinariesManifest {
            schema_version: 1,
            version: version.to_string(),
            platforms: std::collections::HashMap::new(),
        };
        // Mirror lags GitHub during its sync window; the newer one must win.
        let manifests = vec![
            ("GitHub", manifest("1.0.1")),
            ("openbitfun.com", manifest("1.0.0")),
        ];
        assert_eq!(newest_version(&manifests), "1.0.1");

        let reversed = vec![
            ("GitHub", manifest("1.0.0")),
            ("openbitfun.com", manifest("1.0.1")),
        ];
        assert_eq!(newest_version(&reversed), "1.0.1");
    }

    #[test]
    fn version_comparison_ignores_release_metadata() {
        assert!(is_newer_version("1.0.1", "1.0.0"));
        assert!(!is_newer_version("1.0.0", "1.0.0-nightly.1+abc"));
        assert!(!is_newer_version("1.0.0", "1.0.1"));
    }

    #[test]
    fn prerelease_cli_builds_do_not_use_the_stable_auto_update_feed() {
        assert!(release_version_allows_automatic_update("1.0.0"));
        assert!(!release_version_allows_automatic_update("0.2.14"));
        assert!(!release_version_allows_automatic_update("1.0.0-beta.1"));
        assert!(!release_version_allows_automatic_update(
            "1.0.0-nightly.20260811"
        ));
    }

    /// Fixture produced with the Tauri signer CLI in its base64-wrapped
    /// minisign wire format, pinning the exact on-disk format CI must emit.
    const FIXTURE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IERENTQzQUM5RUY0NTIzRTMKUldUakkwWHZ5VHBVM1NOMXJWMHhLVlljSDBOY2x4YlpxVHA2clN1NEJPMWcyY2Qvd2U4VUR2b3AK";
    const FIXTURE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUakkwWHZ5VHBVM2RVVFdoR3FNZDltSWNUeEQ1K2ZnNWRUSnYxWk5lUkZzd0h0MkdzSUhUSlV6a0haUTdNZm1aemM5QVBQWW50UWgvaWpFcEp1Zkp4SERWdnhIc1g2YUFrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg4NDg2NTU4CWZpbGU6Lm9wZW5iaXRmdW4tbWluaXNpZ24tZml4dHVyZS50eHQKa1QxdDQ3bWtLVlhaZUdFSjR4R0V5R1Z3REVnUlI0RGJqbHFoZkVHdkdLSlFyTGJ5Z05JRTI5V3dwdXRkSFpZckUrK0RaUVVJYUJod1dzcmVydHZnQXc9PQo=";
    const FIXTURE_DATA: &[u8] = b"hello-openbitfun\n";

    #[test]
    fn release_signature_accepts_the_tauri_wire_format() {
        verify_signature(FIXTURE_DATA, FIXTURE_SIGNATURE, FIXTURE_PUBKEY)
            .expect("minisign signature in Tauri's base64 wrapper must verify");
        let raw_pubkey = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(FIXTURE_PUBKEY)
                .expect("decode fixture public key"),
        )
        .expect("fixture public key is UTF-8");
        verify_signature(FIXTURE_DATA, FIXTURE_SIGNATURE, &raw_pubkey)
            .expect("raw minisign public key must verify");
    }

    #[test]
    fn release_signature_rejects_tampered_bytes() {
        // The whole point: a mirror that alters the archive cannot also forge
        // this, unlike the checksum it serves alongside it.
        let tampered = b"hello-openbitfun-tampered\n";
        assert!(verify_signature(tampered, FIXTURE_SIGNATURE, FIXTURE_PUBKEY).is_err());
        assert!(verify_signature(FIXTURE_DATA, "bm90LWEtc2lnbmF0dXJl", FIXTURE_PUBKEY).is_err());
    }

    #[test]
    fn checksum_contract_accepts_standard_sha_file() {
        let data = b"openbitfun";
        let digest = format!("{:x}", Sha256::digest(data));
        verify_sha256(
            data,
            &format!("{digest}  archive.tar.gz\n"),
            "archive.tar.gz",
        )
        .unwrap();
        assert!(verify_sha256(
            data,
            &format!("{}  archive.tar.gz", "0".repeat(64)),
            "archive.tar.gz"
        )
        .is_err());
    }
}
