use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

use openbitfun_core::service::remote_ssh::{SSHCommandOptions, SSHConnectionManager};
use openbitfun_core::util::errors::{OpenBitFunError, OpenBitFunResult};
use tokio::process::Command;

use super::builtin_clients::builtin_acp_client_preset;
use super::config::{AcpClientConfig, AcpRequirementProbeItem};
use super::remote_shell::{remote_user_shell_command, render_remote_env_assignments, shell_escape};

const REQUIREMENT_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// A first download of an adapter that bundles its agent binary (Claude Code's
/// is about 300 MB) routinely takes longer than two minutes.
pub(crate) const ADAPTER_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const CLI_INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

pub(crate) struct AcpRequirementSpec<'a> {
    pub(crate) tool_command: &'a str,
    pub(crate) install_package: Option<&'a str>,
    pub(crate) adapter: Option<AcpAdapterSpec<'a>>,
}

pub(crate) struct AcpAdapterSpec<'a> {
    pub(crate) package: &'a str,
    pub(crate) bin: &'a str,
}

pub(crate) fn acp_requirement_spec<'a>(
    client_id: &'a str,
    config: Option<&'a AcpClientConfig>,
) -> AcpRequirementSpec<'a> {
    if let Some(preset) = builtin_acp_client_preset(client_id) {
        return AcpRequirementSpec {
            tool_command: preset.tool_command,
            install_package: preset.install_package,
            adapter: match (preset.adapter_package, preset.adapter_bin) {
                (Some(package), Some(bin)) => Some(AcpAdapterSpec { package, bin }),
                _ => None,
            },
        };
    }

    AcpRequirementSpec {
        tool_command: config
            .map(|config| config.command.as_str())
            .unwrap_or(client_id),
        install_package: None,
        adapter: None,
    }
}

pub(crate) async fn probe_executable(command: &str) -> AcpRequirementProbeItem {
    let path = find_executable(command);
    let mut item = AcpRequirementProbeItem {
        name: command.to_string(),
        installed: path.is_some(),
        version: None,
        path: path.as_ref().map(|path| path.to_string_lossy().to_string()),
        error: None,
    };

    if let Some(path) = path {
        match run_command_with_timeout(path.as_os_str(), ["--version"], REQUIREMENT_PROBE_TIMEOUT)
            .await
        {
            Ok(output) if output.status.success() => {
                item.version = parse_version_text(&output.stdout)
                    .or_else(|| parse_version_text(&output.stderr));
            }
            Ok(output) => {
                item.error = Some(command_error_summary(&output.stderr, &output.stdout));
            }
            Err(error) => {
                item.error = Some(error);
            }
        }
    }

    item
}

pub(crate) async fn probe_npm_adapter(package: &str, bin: &str) -> AcpRequirementProbeItem {
    probe_npm_adapter_with_path(package, bin, None).await
}

async fn probe_npm_adapter_with_path(
    package: &str,
    bin: &str,
    configured_path: Option<&OsStr>,
) -> AcpRequirementProbeItem {
    let mut item = AcpRequirementProbeItem {
        name: package.to_string(),
        installed: false,
        version: None,
        path: None,
        error: None,
    };
    if find_executable_with_path("npx", configured_path).is_some() {
        return npx_adapter_probe_item(package);
    }

    let npm_path = find_executable_with_path("npm", configured_path);
    let Some(npm_path) = npm_path else {
        item.error = Some("npm and npx are not available on PATH".to_string());
        return item;
    };

    let global_args = ["ls", "-g", "--json", "--depth=0", package];
    match run_command_with_timeout(npm_path.as_os_str(), global_args, REQUIREMENT_PROBE_TIMEOUT)
        .await
    {
        Ok(output) if output.status.success() => {
            if let Some(version) = npm_ls_package_version(&output.stdout, package) {
                item.installed = true;
                item.version = Some(version);
                item.path = Some("npm global".to_string());
                return item;
            }
        }
        Ok(output) => {
            item.error = Some(command_error_summary(&output.stderr, &output.stdout));
        }
        Err(error) => {
            item.error = Some(error);
        }
    }

    let offline_args = npm_offline_probe_args(package, bin);
    match run_command_with_timeout(
        npm_path.as_os_str(),
        offline_args.iter().map(String::as_str),
        REQUIREMENT_PROBE_TIMEOUT,
    )
    .await
    {
        Ok(output) if output.status.success() => {
            item.installed = true;
            item.path = Some("npm offline cache".to_string());
            item.error = None;
        }
        Ok(output) => {
            item.error = Some(command_error_summary(&output.stderr, &output.stdout));
        }
        Err(error) => {
            item.error = Some(error);
        }
    }

    item
}

fn npm_offline_probe_args(package: &str, bin: &str) -> [String; 7] {
    [
        "exec".to_string(),
        "--offline".to_string(),
        "--yes".to_string(),
        format!("--package={package}"),
        "--".to_string(),
        bin.to_string(),
        "--help".to_string(),
    ]
}

fn npx_adapter_probe_item(package: &str) -> AcpRequirementProbeItem {
    AcpRequirementProbeItem {
        name: package.to_string(),
        installed: true,
        version: None,
        path: Some("npx auto-install".to_string()),
        error: None,
    }
}

pub(crate) async fn probe_remote_executable(
    ssh_manager: &SSHConnectionManager,
    connection_id: &str,
    command: &str,
    env: Option<&HashMap<String, String>>,
) -> AcpRequirementProbeItem {
    let mut item = AcpRequirementProbeItem {
        name: command.to_string(),
        installed: false,
        version: None,
        path: None,
        error: None,
    };

    let env_prefix = render_remote_env_prefix(env);
    let resolve_command =
        remote_user_shell_command(&format!("{env_prefix}command -v {}", shell_escape(command)));
    match ssh_manager
        .execute_command(connection_id, &resolve_command)
        .await
    {
        Ok((stdout, _stderr, 0)) => {
            let resolved_path = stdout
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(ToString::to_string);
            item.installed = resolved_path.is_some();
            item.path = resolved_path;
        }
        Ok((stdout, stderr, _)) => {
            let summary = remote_command_error_summary(&stderr, &stdout);
            if !summary.is_empty() {
                item.error = Some(summary);
            }
        }
        Err(error) => {
            item.error = Some(error.to_string());
        }
    }

    if item.installed {
        let version_command =
            remote_user_shell_command(&format!("{env_prefix}{} --version", shell_escape(command)));
        match ssh_manager
            .execute_command(connection_id, &version_command)
            .await
        {
            Ok((stdout, stderr, 0)) => {
                item.version = parse_version_text(stdout.as_bytes())
                    .or_else(|| parse_version_text(stderr.as_bytes()));
            }
            Ok((stdout, stderr, _)) => {
                item.error = Some(remote_command_error_summary(&stderr, &stdout));
            }
            Err(error) => {
                item.error = Some(error.to_string());
            }
        }
    }

    item
}

pub(crate) async fn probe_remote_npx_adapter(
    ssh_manager: &SSHConnectionManager,
    connection_id: &str,
    package: &str,
    env: Option<&HashMap<String, String>>,
) -> AcpRequirementProbeItem {
    let mut item = AcpRequirementProbeItem {
        name: package.to_string(),
        installed: false,
        version: None,
        path: None,
        error: None,
    };

    let env_prefix = render_remote_env_prefix(env);
    let resolve_command = remote_user_shell_command(&format!("{env_prefix}command -v npx"));
    match ssh_manager
        .execute_command(connection_id, &resolve_command)
        .await
    {
        Ok((stdout, _stderr, 0)) => {
            item.installed = true;
            item.path = stdout
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(ToString::to_string)
                .or_else(|| Some("remote npx auto-install".to_string()));
        }
        Ok((stdout, stderr, _)) => {
            let summary = remote_command_error_summary(&stderr, &stdout);
            item.error = Some(if summary.is_empty() {
                "npx is not available on remote PATH".to_string()
            } else {
                summary
            });
        }
        Err(error) => {
            item.error = Some(error.to_string());
        }
    }

    item
}

pub(crate) async fn predownload_npm_adapter(package: &str, bin: &str) -> OpenBitFunResult<()> {
    let npm_path = find_executable("npm")
        .ok_or_else(|| OpenBitFunError::service("npm is not available on PATH".to_string()))?;
    let args = npm_predownload_args(package, bin);

    match run_command_with_timeout(
        npm_path.as_os_str(),
        args.iter().map(String::as_str),
        ADAPTER_DOWNLOAD_TIMEOUT,
    )
    .await
    {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => Err(OpenBitFunError::service(format!(
            "Failed to predownload ACP adapter '{}': {}",
            package,
            command_error_summary(&output.stderr, &output.stdout)
        ))),
        Err(error) => Err(OpenBitFunError::service(format!(
            "Failed to predownload ACP adapter '{}': {}",
            package, error
        ))),
    }
}

/// An npx command line that launches a built-in adapter, split at the package
/// spec npx installs before it runs the adapter.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct NpxAdapterLaunch<'a> {
    options: &'a [String],
    spec: &'a str,
    bin: &'a str,
}

/// Finds the adapter package spec in a configured npx launch.
///
/// npx keys its install cache by the spec text exactly as written, so a
/// download only helps a later launch when both use this same spec.
pub(crate) fn npx_adapter_launch<'a>(
    config: &'a AcpClientConfig,
    adapter: &AcpAdapterSpec<'a>,
) -> Option<NpxAdapterLaunch<'a>> {
    if !is_npx_command(&config.command) {
        return None;
    }
    let index = config
        .args
        .iter()
        .position(|arg| is_package_spec(arg, adapter.package))?;
    Some(NpxAdapterLaunch {
        options: &config.args[..index],
        spec: &config.args[index],
        bin: adapter.bin,
    })
}

impl NpxAdapterLaunch<'_> {
    pub(crate) fn spec(&self) -> &str {
        self.spec
    }

    /// Installs the launch spec without starting an ACP session: the adapter
    /// prints its version and exits once npx has it in place.
    fn prepare_args(&self) -> Vec<String> {
        let mut args = self.options.to_vec();
        if !args.iter().any(|arg| arg == "--yes" || arg == "-y") {
            args.push("--yes".to_string());
        }
        args.push(format!("--package={}", self.spec));
        args.push("--".to_string());
        args.push(self.bin.to_string());
        args.push("--version".to_string());
        args
    }
}

fn is_npx_command(command: &str) -> bool {
    Path::new(command.trim())
        .file_stem()
        .and_then(OsStr::to_str)
        .is_some_and(|stem| stem.eq_ignore_ascii_case("npx"))
}

fn is_package_spec(arg: &str, package: &str) -> bool {
    arg.strip_prefix(package)
        .is_some_and(|version| version.is_empty() || version.starts_with('@'))
}

/// Why an adapter could not be put in place before its launch.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AdapterPrepareError {
    /// The download outlasted [`ADAPTER_DOWNLOAD_TIMEOUT`].
    TimedOut,
    /// npx ran and failed, or could not be run.
    Failed(String),
}

impl AdapterPrepareError {
    pub(crate) fn into_error(self, client_id: &str, spec: &str) -> OpenBitFunError {
        match self {
            Self::TimedOut => OpenBitFunError::service(format!(
                "Downloading the ACP adapter '{}' for client '{}' did not finish within {}s. Check the network or npm registry and try again.",
                spec,
                client_id,
                ADAPTER_DOWNLOAD_TIMEOUT.as_secs()
            )),
            Self::Failed(detail) => OpenBitFunError::service(format!(
                "Failed to download the ACP adapter '{}' for client '{}': {}",
                spec, client_id, detail
            )),
        }
    }
}

/// Applies the launch policy to an adapter preparation result.
///
/// Only a download that outlasts its own timeout fails the launch: retrying it
/// under the shorter handshake timeout cannot succeed. Any other failure is
/// logged and left to the launch, which reports it the same way it always has.
pub(crate) fn adapter_ready_for_launch(
    client_id: &str,
    spec: &str,
    result: Result<(), AdapterPrepareError>,
) -> OpenBitFunResult<()> {
    match result {
        Ok(()) => Ok(()),
        Err(AdapterPrepareError::TimedOut) => {
            Err(AdapterPrepareError::TimedOut.into_error(client_id, spec))
        }
        Err(AdapterPrepareError::Failed(detail)) => {
            log::warn!(
                "ACP adapter preparation failed; launching anyway: id={} spec={} error={}",
                client_id,
                spec,
                detail
            );
            Ok(())
        }
    }
}

/// Lets npx finish installing the adapter before the launch starts timing the
/// ACP handshake, so a new adapter release is not killed halfway through its
/// download.
pub(crate) async fn prepare_npx_adapter(
    client_id: &str,
    config: &AcpClientConfig,
    launch: &NpxAdapterLaunch<'_>,
) -> Result<(), AdapterPrepareError> {
    let program = resolve_configured_command(&config.command, &config.env);
    let mut command = openbitfun_core::util::process_manager::create_tokio_command(&program);
    command.args(launch.prepare_args());
    apply_command_environment(&mut command, Some(&config.env));
    let started_at = std::time::Instant::now();
    match tokio::time::timeout(ADAPTER_DOWNLOAD_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            log::debug!(
                "ACP adapter ready: id={} spec={} duration_ms={}",
                client_id,
                launch.spec,
                started_at.elapsed().as_millis()
            );
            Ok(())
        }
        Ok(Ok(output)) => Err(AdapterPrepareError::Failed(command_error_summary(
            &output.stderr,
            &output.stdout,
        ))),
        Ok(Err(error)) => Err(AdapterPrepareError::Failed(error.to_string())),
        Err(_) => Err(AdapterPrepareError::TimedOut),
    }
}

/// The SSH-host counterpart of [`prepare_npx_adapter`].
pub(crate) async fn prepare_remote_npx_adapter(
    ssh_manager: &SSHConnectionManager,
    connection_id: &str,
    config: &AcpClientConfig,
    launch: &NpxAdapterLaunch<'_>,
) -> Result<(), AdapterPrepareError> {
    let mut parts = vec![shell_escape(config.command.trim())];
    parts.extend(launch.prepare_args().iter().map(|arg| shell_escape(arg)));
    let command = remote_user_shell_command(&format!(
        "{}{}",
        render_remote_env_prefix(Some(&config.env)),
        parts.join(" ")
    ));
    let timeout_ms = u64::try_from(ADAPTER_DOWNLOAD_TIMEOUT.as_millis()).unwrap_or(u64::MAX);
    match ssh_manager
        .execute_command_with_options(
            connection_id,
            &command,
            SSHCommandOptions {
                timeout_ms: Some(timeout_ms),
                cancellation_token: None,
            },
        )
        .await
    {
        Ok(output) if output.timed_out => Err(AdapterPrepareError::TimedOut),
        Ok(output) if output.exit_code == 0 && !output.interrupted => Ok(()),
        Ok(output) if output.interrupted => Err(AdapterPrepareError::Failed(
            "command was cancelled".to_string(),
        )),
        Ok(output) => Err(AdapterPrepareError::Failed(remote_command_error_summary(
            &output.stderr,
            &output.stdout,
        ))),
        Err(error) => Err(AdapterPrepareError::Failed(error.to_string())),
    }
}

fn npm_predownload_args(package: &str, bin: &str) -> [String; 6] {
    [
        "exec".to_string(),
        "--yes".to_string(),
        format!("--package={package}"),
        "--".to_string(),
        bin.to_string(),
        "--help".to_string(),
    ]
}

pub(crate) async fn install_npm_cli_package(package: &str) -> OpenBitFunResult<()> {
    let npm_path = find_executable("npm")
        .ok_or_else(|| OpenBitFunError::service("npm is not available on PATH".to_string()))?;
    let args = ["install", "-g", package];

    match run_command_with_timeout(npm_path.as_os_str(), args, CLI_INSTALL_TIMEOUT).await {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => Err(OpenBitFunError::service(format!(
            "Failed to install ACP agent CLI '{}': {}",
            package,
            command_error_summary(&output.stderr, &output.stdout)
        ))),
        Err(error) => Err(OpenBitFunError::service(format!(
            "Failed to install ACP agent CLI '{}': {}",
            package, error
        ))),
    }
}

pub(crate) async fn install_remote_npm_cli_package(
    ssh_manager: &SSHConnectionManager,
    connection_id: &str,
    package: &str,
) -> OpenBitFunResult<()> {
    let command = remote_user_shell_command(&format!("npm install -g {}", shell_escape(package)));
    let timeout_ms = u64::try_from(CLI_INSTALL_TIMEOUT.as_millis()).unwrap_or(u64::MAX);
    match ssh_manager
        .execute_command_with_options(
            connection_id,
            &command,
            SSHCommandOptions {
                timeout_ms: Some(timeout_ms),
                cancellation_token: None,
            },
        )
        .await
    {
        Ok(output) if output.exit_code == 0 && !output.timed_out && !output.interrupted => Ok(()),
        Ok(output) if output.timed_out => Err(OpenBitFunError::service(format!(
            "Failed to install remote ACP agent CLI '{}': command timed out",
            package
        ))),
        Ok(output) if output.interrupted => Err(OpenBitFunError::service(format!(
            "Failed to install remote ACP agent CLI '{}': command was cancelled",
            package
        ))),
        Ok(output) => Err(OpenBitFunError::service(format!(
            "Failed to install remote ACP agent CLI '{}': {}",
            package,
            remote_command_error_summary(&output.stderr, &output.stdout)
        ))),
        Err(error) => Err(OpenBitFunError::service(format!(
            "Failed to install remote ACP agent CLI '{}': {}",
            package, error
        ))),
    }
}

pub(crate) fn resolve_configured_command(
    command: &str,
    extra_env: &HashMap<String, String>,
) -> PathBuf {
    let configured_path = configured_path_value(extra_env);
    find_executable_with_path(command, configured_path.as_deref())
        .unwrap_or_else(|| PathBuf::from(command))
}

pub(crate) fn apply_command_environment(
    command: &mut Command,
    extra_env: Option<&HashMap<String, String>>,
) {
    let configured_path = extra_env.and_then(configured_path_value);
    let search_path = joined_command_search_path(configured_path.as_deref());
    if !search_path.is_empty() {
        command.env("PATH", search_path);
    }

    if let Some(extra_env) = extra_env {
        for (key, value) in extra_env {
            if !key.eq_ignore_ascii_case("PATH") {
                command.env(key, value);
            }
        }
    }
}

async fn run_command_with_timeout<I, S>(
    program: &OsStr,
    args: I,
    timeout: Duration,
) -> Result<std::process::Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = openbitfun_core::util::process_manager::create_tokio_command(program);
    command.args(args);
    apply_command_environment(&mut command, None);
    match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("Timed out while checking command".to_string()),
    }
}

fn npm_ls_package_version(stdout: &[u8], package: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(stdout).ok()?;
    value
        .get("dependencies")?
        .get(package)?
        .get("version")?
        .as_str()
        .map(ToString::to_string)
}

fn parse_version_text(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(output);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

fn command_error_summary(stderr: &[u8], stdout: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if !stderr.is_empty() {
        return truncate_error(stderr);
    }
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    if !stdout.is_empty() {
        return truncate_error(stdout);
    }
    "Command exited unsuccessfully".to_string()
}

fn remote_command_error_summary(stderr: &str, stdout: &str) -> String {
    let stderr = stderr.trim().to_string();
    if !stderr.is_empty() {
        return truncate_error(stderr);
    }
    let stdout = stdout.trim().to_string();
    if !stdout.is_empty() {
        return truncate_error(stdout);
    }
    String::new()
}

fn truncate_error(value: String) -> String {
    const MAX_LEN: usize = 240;
    if value.chars().count() <= MAX_LEN {
        return value;
    }
    format!("{}...", value.chars().take(MAX_LEN).collect::<String>())
}

fn render_remote_env_prefix(env: Option<&HashMap<String, String>>) -> String {
    let Some(env) = env else {
        return String::new();
    };
    let assignments = render_remote_env_assignments(env);
    if assignments.is_empty() {
        return String::new();
    }
    format!("{} ", assignments.join(" "))
}

fn find_executable(command: &str) -> Option<PathBuf> {
    find_executable_with_path(command, None)
}

fn find_executable_with_path(command: &str, configured_path: Option<&OsStr>) -> Option<PathBuf> {
    let command_path = PathBuf::from(command);
    if command_path.components().count() > 1 {
        return executable_file(&command_path).then_some(command_path);
    }

    for directory in command_search_paths(configured_path) {
        for candidate in executable_candidates(&directory, command) {
            if executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn configured_path_value(extra_env: &HashMap<String, String>) -> Option<OsString> {
    extra_env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| OsString::from(value))
}

fn joined_command_search_path(configured_path: Option<&OsStr>) -> OsString {
    let paths = command_search_paths(configured_path);
    if paths.is_empty() {
        return OsString::new();
    }
    env::join_paths(paths).unwrap_or_else(|_| env::var_os("PATH").unwrap_or_default())
}

fn command_search_paths(configured_path: Option<&OsStr>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    if let Some(configured_path) = configured_path {
        push_split_paths(&mut paths, &mut seen, configured_path);
    }
    if let Some(env_path) = env::var_os("PATH") {
        push_split_paths(&mut paths, &mut seen, &env_path);
    }

    push_user_bin_paths(&mut paths, &mut seen);
    push_system_bin_paths(&mut paths, &mut seen);
    paths
}

fn push_split_paths(paths: &mut Vec<PathBuf>, seen: &mut HashSet<OsString>, value: &OsStr) {
    for directory in env::split_paths(value) {
        push_search_path(paths, seen, directory);
    }
}

fn push_user_bin_paths(paths: &mut Vec<PathBuf>, seen: &mut HashSet<OsString>) {
    let Some(home) = env::var_os("HOME") else {
        return;
    };
    let home = PathBuf::from(home);
    push_existing_search_path(paths, seen, home.join(".local/bin"));
    push_existing_search_path(paths, seen, home.join(".cargo/bin"));
    push_existing_search_path(paths, seen, home.join(".npm-global/bin"));
}

fn push_system_bin_paths(paths: &mut Vec<PathBuf>, seen: &mut HashSet<OsString>) {
    #[cfg(target_os = "macos")]
    {
        for prefix in ["/opt/homebrew", "/usr/local"] {
            push_existing_search_path(paths, seen, PathBuf::from(format!("{prefix}/bin")));
            push_existing_search_path(paths, seen, PathBuf::from(format!("{prefix}/sbin")));
            for node in ["node", "node@18", "node@20", "node@22", "node@24"] {
                push_existing_search_path(
                    paths,
                    seen,
                    PathBuf::from(format!("{prefix}/opt/{node}/bin")),
                );
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (paths, seen);
    }
}

fn push_existing_search_path(
    paths: &mut Vec<PathBuf>,
    seen: &mut HashSet<OsString>,
    path: PathBuf,
) {
    if path.is_dir() {
        push_search_path(paths, seen, path);
    }
}

fn push_search_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<OsString>, path: PathBuf) {
    if path.as_os_str().is_empty() {
        return;
    }

    let key = search_path_key(&path);
    if seen.insert(key) {
        paths.push(path);
    }
}

fn search_path_key(path: &Path) -> OsString {
    #[cfg(windows)]
    {
        OsString::from(path.to_string_lossy().to_ascii_lowercase())
    }
    #[cfg(not(windows))]
    {
        path.as_os_str().to_os_string()
    }
}

fn executable_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let command_path = PathBuf::from(command);
        if command_path.extension().is_some() {
            return vec![directory.join(command)];
        }
        let extensions = env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".EXE;.BAT;.CMD"));
        extensions
            .to_string_lossy()
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(|extension| directory.join(format!("{command}{extension}")))
            .collect()
    }

    #[cfg(not(windows))]
    {
        vec![directory.join(command)]
    }
}

fn executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::builtin_clients::default_config_for_builtin_client;

    fn claude_adapter() -> AcpAdapterSpec<'static> {
        acp_requirement_spec("claude-code", None)
            .adapter
            .expect("Claude adapter")
    }

    fn npx_config(command: &str, args: &[&str]) -> AcpClientConfig {
        let mut config = default_config_for_builtin_client("claude-code").expect("builtin config");
        config.command = command.to_string();
        config.args = args.iter().map(|arg| (*arg).to_string()).collect();
        config
    }

    #[test]
    fn adapter_preparation_installs_the_spec_the_builtin_launch_runs() {
        let config = default_config_for_builtin_client("claude-code").expect("builtin config");
        let adapter = claude_adapter();
        let launch = npx_adapter_launch(&config, &adapter).expect("npx launch");

        // npx caches by spec text, so preparation must name the launch arg verbatim.
        assert!(config.args.iter().any(|arg| arg == launch.spec()));
        assert_eq!(
            launch.prepare_args(),
            [
                "--yes",
                "--package=@agentclientprotocol/claude-agent-acp@latest",
                "--",
                "claude-agent-acp",
                "--version",
            ]
            .map(str::to_string)
        );
    }

    #[test]
    fn adapter_launch_keeps_pinned_versions_and_npx_options() {
        let config = npx_config(
            "/opt/homebrew/bin/npx",
            &[
                "-y",
                "--registry=https://registry.example.test/",
                "@agentclientprotocol/claude-agent-acp@0.99.0",
                "--adapter-flag",
            ],
        );
        let adapter = claude_adapter();
        let launch = npx_adapter_launch(&config, &adapter).expect("npx launch");

        assert_eq!(
            launch.spec(),
            "@agentclientprotocol/claude-agent-acp@0.99.0"
        );
        assert_eq!(
            launch.prepare_args(),
            [
                "-y",
                "--registry=https://registry.example.test/",
                "--package=@agentclientprotocol/claude-agent-acp@0.99.0",
                "--",
                "claude-agent-acp",
                "--version",
            ]
            .map(str::to_string)
        );
    }

    #[test]
    fn adapter_launch_matches_bare_specs_and_windows_shims() {
        let config = npx_config("npx.cmd", &["@agentclientprotocol/claude-agent-acp"]);
        let adapter = claude_adapter();
        let launch = npx_adapter_launch(&config, &adapter).expect("npx launch");

        assert_eq!(launch.spec(), "@agentclientprotocol/claude-agent-acp");
        assert_eq!(launch.prepare_args()[0], "--yes");
    }

    #[test]
    fn adapter_launch_ignores_commands_that_npx_does_not_install() {
        let adapter = claude_adapter();
        for config in [
            npx_config("claude-agent-acp", &[]),
            npx_config(
                "npm",
                &["exec", "@agentclientprotocol/claude-agent-acp@latest"],
            ),
            npx_config(
                "npx",
                &["--yes", "@agentclientprotocol/claude-agent-acp-fork@latest"],
            ),
            npx_config("npx", &["--yes", "./local-adapter"]),
        ] {
            assert_eq!(npx_adapter_launch(&config, &adapter), None, "{config:?}");
        }
    }

    #[test]
    fn only_a_download_timeout_fails_the_launch() {
        assert!(adapter_ready_for_launch("claude-code", "spec", Ok(())).is_ok());
        assert!(adapter_ready_for_launch(
            "claude-code",
            "spec",
            Err(AdapterPrepareError::Failed("offline".to_string())),
        )
        .is_ok());

        let error = adapter_ready_for_launch(
            "claude-code",
            "@agentclientprotocol/claude-agent-acp@latest",
            Err(AdapterPrepareError::TimedOut),
        )
        .expect_err("timeout fails the launch")
        .to_string();
        assert!(error.contains("@agentclientprotocol/claude-agent-acp@latest"));
        assert!(error.contains(&format!("{}s", ADAPTER_DOWNLOAD_TIMEOUT.as_secs())));
    }

    #[test]
    fn npm_adapter_argument_builders_preserve_cli_order() {
        assert_eq!(
            npm_offline_probe_args("@agentclientprotocol/codex-acp", "codex-acp"),
            [
                "exec",
                "--offline",
                "--yes",
                "--package=@agentclientprotocol/codex-acp",
                "--",
                "codex-acp",
                "--help",
            ]
            .map(str::to_string)
        );
        assert_eq!(
            npm_predownload_args("@agentclientprotocol/codex-acp", "codex-acp"),
            [
                "exec",
                "--yes",
                "--package=@agentclientprotocol/codex-acp",
                "--",
                "codex-acp",
                "--help",
            ]
            .map(str::to_string)
        );
    }

    #[test]
    fn builtin_adapter_specs_use_maintained_agent_client_protocol_packages() {
        let claude = acp_requirement_spec("claude-code", None)
            .adapter
            .expect("Claude adapter");
        assert_eq!(claude.package, "@agentclientprotocol/claude-agent-acp");
        assert_eq!(claude.bin, "claude-agent-acp");

        let codex = acp_requirement_spec("codex", None)
            .adapter
            .expect("Codex adapter");
        assert_eq!(codex.package, "@agentclientprotocol/codex-acp");
        assert_eq!(codex.bin, "codex-acp");
    }

    #[test]
    fn command_search_paths_keep_configured_path_first() {
        let configured_paths = env::join_paths([
            PathBuf::from("/tmp/openbitfun-acp-first"),
            PathBuf::from("/tmp/openbitfun-acp-second"),
        ])
        .expect("test paths should be joinable");

        let paths = command_search_paths(Some(&configured_paths));

        assert_eq!(
            paths.first(),
            Some(&PathBuf::from("/tmp/openbitfun-acp-first"))
        );
        assert_eq!(
            paths.get(1),
            Some(&PathBuf::from("/tmp/openbitfun-acp-second"))
        );
    }

    #[test]
    fn find_executable_uses_configured_path() {
        let test_dir = env::temp_dir().join(format!("openbitfun-acp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&test_dir).expect("test dir should be created");

        #[cfg(windows)]
        let file_name = "openbitfun-test-tool.EXE";
        #[cfg(not(windows))]
        let file_name = "openbitfun-test-tool";

        let executable = test_dir.join(file_name);
        std::fs::write(&executable, b"").expect("test executable should be written");

        let found = find_executable_with_path("openbitfun-test-tool", Some(test_dir.as_os_str()));

        let _ = std::fs::remove_dir_all(&test_dir);
        assert_eq!(found, Some(executable));
    }

    #[test]
    fn npx_adapter_probe_item_marks_auto_install_available() {
        let item = npx_adapter_probe_item("@agentclientprotocol/codex-acp");

        assert_eq!(item.name, "@agentclientprotocol/codex-acp");
        assert!(item.installed);
        assert_eq!(item.path.as_deref(), Some("npx auto-install"));
        assert!(item.error.is_none());
    }

    #[test]
    fn probe_npm_adapter_skips_npm_probe_when_npx_is_available() {
        let test_dir = env::temp_dir().join(format!("openbitfun-acp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&test_dir).expect("test dir should be created");
        let npm_marker = test_dir.join("npm-was-run");

        write_command_stub(&test_dir, "npx", "");
        write_command_stub(&test_dir, "npm", &npm_probe_marker_script(&npm_marker));

        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime should be created");
        let item = runtime.block_on(probe_npm_adapter_with_path(
            "@agentclientprotocol/codex-acp",
            "codex-acp",
            Some(test_dir.as_os_str()),
        ));

        assert!(item.installed);
        assert_eq!(item.path.as_deref(), Some("npx auto-install"));
        assert!(
            !npm_marker.exists(),
            "npm probe should not run when npx can launch the adapter"
        );
        let _ = std::fs::remove_dir_all(&test_dir);
    }

    #[test]
    fn remote_env_prefix_uses_valid_keys_in_stable_order() {
        let env = HashMap::from([
            ("INVALID-NAME".to_string(), "ignored".to_string()),
            ("PATH".to_string(), "/remote/bin:/usr/bin".to_string()),
            ("ACP_HOME".to_string(), "/tmp/acp home".to_string()),
        ]);

        assert_eq!(
            render_remote_env_prefix(Some(&env)),
            "ACP_HOME='/tmp/acp home' PATH=/remote/bin:/usr/bin "
        );
    }

    fn write_command_stub(directory: &Path, command: &str, body: &str) -> PathBuf {
        #[cfg(windows)]
        let path = directory.join(format!("{command}.cmd"));
        #[cfg(not(windows))]
        let path = directory.join(command);

        std::fs::write(&path, body).expect("command stub should be written");

        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&path)
                .expect("command stub metadata should be readable")
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions)
                .expect("command stub should be executable");
        }

        path
    }

    fn npm_probe_marker_script(marker_path: &Path) -> String {
        #[cfg(windows)]
        {
            format!(
                "@echo off\r\necho called > \"{}\"\r\nexit /b 42\r\n",
                marker_path.display()
            )
        }
        #[cfg(not(windows))]
        {
            format!(
                "#!/bin/sh\necho called > '{}'\nexit 42\n",
                marker_path.display()
            )
        }
    }
}
